# SnkeOS Learnings

The original README has been moved to [ORIGINAL_README.md](./ORIGINAL_README.md).

Please carefully read [DEVELOPMENT.md](./DEVELOPMENT.md) and especially read my learnings below, they might save you some
pain:

## First thing to install is NVM (Node Version Manager)

First install [NVM](https://github.com/nvm-sh/nvm).
Then use it to install a NodeJS version.
Then install rush.js as described in [DEVELOPMENT.md](./DEVELOPMENT.md).

## Rule 1: Always use rush.js

Don't run any `yarn`, `pnpm` or `npm` commands. Otherwise, things could get messy.

## Testing a single project

To test a single project run

```shell
rush test --only @aws/fhir-works-on-aws-routing
```

## Fixed the source code of some of the tests, but they keep failing with the same error?

Got you covered, you need to run

```shell
rush rebuild; rush test
```

## Build error: '<XYZ>' is not recognized as an internal or external command, operable program or batch file.

This error occurs on Windows Powershell or Git Bash. If you see this error check the package.json file
of the corresponding module commands that start with an environment variable.
Remove the environment variable from the command in package.json.

For instance, change:

`"test": "TZ=UTC heft test --clean --no-build && rushx pkg-json-lint"`

to

`"test": "heft test --clean --no-build && rushx pkg-json-lint"`

Then run:

```shell
export TZ=UTC
```

Then restart your build.

### TODO (Please write these into issues, at the time of writing issues cannot be created)

Things left to do after the migration:

- Make sure jest generates a .xml report as in the single repositories,
  see https://github.com/snkeos/fhir-works-on-aws-authz-rbac/blob/6efb051cccb7baa729c99aced9efac88cfb6f492/package.json#L75
- We removed @aws/fhir-works-on-aws-smart-deployment from rush.json. Should we need to further investigate whether we need this project?
