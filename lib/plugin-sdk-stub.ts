// `@bb/plugin-sdk` is provided by the bb server at runtime, so it does not
// exist in node_modules. Tests alias the module here (see vitest.config.ts).
//
// Only the runtime exports need standing in for: the real `defineRpcContract`
// is the identity function it looks like, and the byte ceiling is a constant.

export function defineRpcContract<Contract>(contract: Contract): Contract {
  return contract;
}

export const PLUGIN_CLI_OUTPUT_MAX_BYTES = 1_048_576;
