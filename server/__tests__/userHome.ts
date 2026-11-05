import { homedir } from "node:os"

/**
 * What decides the user's home for a server start: `os.homedir()` reads HOME
 * on POSIX and USERPROFILE on Windows, and these move parts of the Cogpit home
 * elsewhere. A fixture's own COGPIT_BROWSER_HOME stays as it set it.
 */
const HOME_ENV = ["HOME", "USERPROFILE", "COGPIT_WORKSPACES_DIR", "COGPIT_SLACK_DIR"] as const

/** Run `start` with the user's home at `home` on every platform, restoring the environment after. */
export async function withUserHome<T>(home: string, start: () => Promise<T>): Promise<T> {
  const saved = HOME_ENV.map((name) => [name, process.env[name]] as const)
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.COGPIT_WORKSPACES_DIR
  delete process.env.COGPIT_SLACK_DIR
  try {
    if (homedir() !== home) throw new Error(`os.homedir() is ${homedir()}, not the fixture's ${home}`)
    return await start()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
