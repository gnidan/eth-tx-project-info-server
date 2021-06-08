import { Compile } from "@truffle/compile-solidity";

import type TruffleConfig from "@truffle/config";
import type { WorkflowCompileResult } from "@truffle/compile-common";

import * as Decoder from "@truffle/decoder";
import * as Codec from "@truffle/codec";
import {
  Fetcher,
  FetcherConstructor,
  InvalidNetworkError,
  default as Fetchers
} from "@truffle/source-fetcher";

export interface FetchExternalOptions {
  config: TruffleConfig;
  address: string;
}

export async function fetchExternal({
  config,
  address
}: FetchExternalOptions): Promise<Decoder.ProjectInfo> {
  const { result } = await fetchAndCompile({ config, address });

  const projectInfo = {
    compilations: Codec.Compilations.Utils.shimCompilations(result.compilations)
  };
  return projectInfo;
}

/**
 * Accepts a TruffleConfig and returns a priority-sorted list of fetchers based
 * on provided configuration and whether available fetchers support the current
 * blockchain network.
 * @dev HACK this currently only supports EtherscanFetcher
 */
export async function forTruffleConfig(options: {
  config: TruffleConfig;
}): Promise<Fetcher[]> {
  const { config } = options;
  const networkId = parseInt(config.network_id);

  // respect optional `config.sourceFetchers`, used to specify explicit
  // ordering for which fetchers to use.
  //
  // since this HACK-ily only supports Etherscan, this logic serves to respect
  // configuration that explicitly excludes use of Etherscan.
  const constructors: FetcherConstructor[] = config.sourceFetchers
    ? config.sourceFetchers.map(sourceFetcherName => {
        const Fetcher = Fetchers.find(
          Fetcher => Fetcher.fetcherName === sourceFetcherName
        );

        if (!Fetcher) {
          throw new Error(
            `Unknown external source servce ${sourceFetcherName}.`
          );
        }
        return Fetcher;
      })
    : Fetchers;

  // construct fetchers for networkId
  const fetchers = await Promise.all(
    constructors
      // HACK only support EtherscanFetcher right now
      .filter(({ fetcherName }) => fetcherName === "etherscan")
      .map(async (Fetcher: FetcherConstructor) => {
        const options = config[Fetcher.fetcherName];

        // don't fail on unsupported networks; that's expected behavior
        try {
          return await Fetcher.forNetworkId(networkId, options);
        } catch (error) {
          if (!(error instanceof InvalidNetworkError)) {
            throw error;
          }
        }
      })
  );

  return fetchers.filter((fetcher): fetcher is Fetcher => !!fetcher);
}

async function fetchAndCompile(options: {
  config: TruffleConfig;
  address: string;
}): Promise<{
  contractName: string;
  result: WorkflowCompileResult;
}> {
  const { config, address } = options;
  const fetchers = await forTruffleConfig({ config });

  for (const fetcher of fetchers) {
    //now comes all the hard parts!
    //get our sources
    let result;
    try {
      result = await fetcher.fetchSourcesForAddress(address);
    } catch (error) {
      continue;
    }
    if (result === null) {
      //null means they don't have that address
      continue;
    }
    //if we do have it, extract sources & options
    const { contractName, sources, options } = result;
    if (options.language !== "Solidity") {
      //if it's not Solidity, bail out now
      //break out of the fetcher loop, since *no* fetcher will work here
      break;
    }

    //compile the sources
    const externalConfig = config
      .with({
        compilers: {
          solc: {
            ...options,
            version: options.version.split("+")[0].split("v").join("")
          }
        },
        quiet: true
      })
      .merge({
        //turn on docker if the original config has docker
        compilers: {
          solc: {
            docker: ((config.compilers || {}).solc || {}).docker
          }
        }
      });

    return {
      contractName,
      result: await Compile.sources({
        options: externalConfig,
        sources
      })
    };
  }

  throw new Error("Unable to find");
}

/*
 * TODO probably remove this; but leaving commented in case we need it
 */
// async function findContract<Contract extends CompiledContract>(options: {
//   contractName: string | undefined;
//   contracts: Contract[];
// }): Promise<Contract> {
//   const { contractName, contracts } = options;

//   // simple case; we get the contract name and it matches exactly one contract
//   if (contractName) {
//     const matching = contracts.filter(
//       contract => contract.contractName === contractName
//     );

//     if (matching.length === 1) {
//       return matching[0];
//     }
//   }

//   throw new Error(`Contract ${contractName} not loaded into @truffle/db.`);
// }
