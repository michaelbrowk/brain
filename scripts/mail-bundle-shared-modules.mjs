import path from "node:path";

/** Keeps `service/account-types.js` one module at runtime for a bundle
 *  emitted into `service/`.
 *
 *  The error classes live there, and http.ts maps a failure by `instanceof`.
 *  A bundle that inlines its own copy throws errors the mapper does not
 *  recognise, so a refused SMTP sign-in answered 500 `internal_error` instead
 *  of `smtp_authentication_failed`. Every import that resolves to the file is
 *  rewritten, whatever relative path the importer spelled it with. */
export function sharedMailModulesPlugin(root) {
  const accountTypes = path.join(root, "lib", "mail", "service", "account-types");
  return {
    name: "shared-mail-modules",
    setup(build) {
      build.onResolve({ filter: /account-types$/ }, (args) => {
        if (path.resolve(args.resolveDir, args.path) !== accountTypes) return undefined;
        return { path: "./account-types", external: true };
      });
    },
  };
}
