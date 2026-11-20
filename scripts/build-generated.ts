/**
 * Builds what the app, its tests and typechecks import from the plugin
 * packages' dist/ and from generated/. CI builds them once per job, then sets
 * COGPIT_GENERATED_BUILT=1 so every script that starts with this skips it.
 */
if (process.env.COGPIT_GENERATED_BUILT !== "1") {
  for (const script of ["build:plugin-api", "build:view-kit"]) {
    const { exitCode } = Bun.spawnSync(["bun", "run", script], { stdout: "inherit", stderr: "inherit" })
    if (exitCode !== 0) process.exit(exitCode ?? 1)
  }
}
