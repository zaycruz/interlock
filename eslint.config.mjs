import parser from "@typescript-eslint/parser";

export default [
  { ignores: ["dist/**", "node_modules/**", ".omx/**", "packages/**/dist/**", "packages/**/node_modules/**"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "scripts/*.mjs"],
    languageOptions: { parser },
    rules: {
      "eqeqeq": "error",
      "no-constant-condition": "error",
      "no-debugger": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
    },
  },
  {
    files: ["src/**/*.ts", "packages/*/src/**/*.ts"],
    rules: { complexity: ["error", { max: 10 }] },
  },
];
