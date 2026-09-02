import { describe, it, expect } from "vitest"
import { classifySection, detectFailure, extractPaths, parseSectionedCommand, readFileTarget } from "../sectionedCommand"

describe("parseSectionedCommand", () => {
  it("returns null for a plain command", () => {
    expect(parseSectionedCommand("ls -la", "a\nb")).toBeNull()
    expect(parseSectionedCommand("grep -rn foo src; ls", "x")).toBeNull()
  })

  it("splits labelled sections and pairs each with its output", () => {
    const command =
      'echo ---HOTSWAP; grep -rniE "hot-?swap" server -l; echo ---CONFIG; cat src/a.tsx; echo ---CAPS; grep -n "configWrite" -r src | head -5'
    const result = "---HOTSWAP\nserver/lib/cliProcess.ts\n---CONFIG\nline1\nline2\n---CAPS\n"
    expect(parseSectionedCommand(command, result)).toEqual([
      { label: "HOTSWAP", command: 'grep -rniE "hot-?swap" server -l', output: "server/lib/cliProcess.ts" },
      { label: "CONFIG", command: "cat src/a.tsx", output: "line1\nline2" },
      { label: "CAPS", command: 'grep -n "configWrite" -r src | head -5', output: "" },
    ])
  })

  it("keeps a leading command before the first marker as an unlabelled section", () => {
    const command = "ls server/routes | head; echo ---; grep -rl settings server; echo ---; ls src"
    const result = "config.ts\n---\nserver/a.ts\n---\nApp.tsx"
    expect(parseSectionedCommand(command, result)).toEqual([
      { label: "", command: "ls server/routes | head", output: "config.ts" },
      { label: "", command: "grep -rl settings server", output: "server/a.ts" },
      { label: "", command: "ls src", output: "App.tsx" },
    ])
  })

  it("accepts quoted labels and && chaining", () => {
    const command = 'echo "---ONE" && cat a && echo \'---TWO\' && cat b'
    const result = "---ONE\na\n---TWO\nb"
    expect(parseSectionedCommand(command, result)?.map((s) => s.label)).toEqual(["ONE", "TWO"])
  })

  it("only treats an output line as a marker when it is the next expected label", () => {
    const command = "echo ---MD; cat README.md; echo ---DONE; ls"
    const result = "---MD\n---\ntitle: x\n---\nbody\n---DONE\nfile"
    expect(parseSectionedCommand(command, result)).toEqual([
      { label: "MD", command: "cat README.md", output: "---\ntitle: x\n---\nbody" },
      { label: "DONE", command: "ls", output: "file" },
    ])
  })

  it("leaves output null for sections the result never reached", () => {
    const command = "echo ---A; cat a; echo ---B; cat b; echo ---C; cat c"
    const result = "---A\na\n---B\nb…truncated"
    const sections = parseSectionedCommand(command, result)
    expect(sections?.map((s) => s.output)).toEqual(["a", "b…truncated", null])
    expect(parseSectionedCommand(command, null)?.map((s) => s.output)).toEqual([null, null, null])
  })

  it("keeps multi-command sections intact, including loops and subshells", () => {
    const command =
      'cat x.ts | head -60; echo ---PKG; ls node_modules/@a/ | grep sdk-; for d in node_modules/@a/sdk-*/; do echo "$d"; ls "$d"; done; echo ---DEPS; grep -n "sdk" package.json'
    const sections = parseSectionedCommand(command, null)
    expect(sections?.map((s) => s.command)).toEqual([
      "cat x.ts | head -60",
      'ls node_modules/@a/ | grep sdk-; for d in node_modules/@a/sdk-*/; do echo "$d"; ls "$d"; done',
      'grep -n "sdk" package.json',
    ])
  })

  it("falls back to the plain view when the output never echoed the markers", () => {
    const command = "echo ---A; cat a.ts; echo ---B; cat b.ts"
    expect(parseSectionedCommand(command, "bash: cat: command not found\nsome real output")).toBeNull()
    expect(parseSectionedCommand(command, "")).toBeNull()
  })

  it("skips adjacent markers with nothing between them", () => {
    expect(parseSectionedCommand("echo ---A; echo ---B; cat b; echo ---C; cat c", "---A\n---B\nb\n---C\nc")).toEqual([
      { label: "B", command: "cat b", output: "b" },
      { label: "C", command: "cat c", output: "c" },
    ])
  })

  it("drops a bare trailing echo with no command after it", () => {
    expect(parseSectionedCommand("echo ---A; cat a; echo ---B; cat b; echo ---END", "---A\na\n---B\nb\n---END")).toEqual([
      { label: "A", command: "cat a", output: "a" },
      { label: "B", command: "cat b", output: "b" },
    ])
    expect(parseSectionedCommand("echo ---A; cat a; echo ---B", "---A\na\n---B")).toBeNull()
  })
})

describe("section analysis", () => {
  it("classifies reads, searches, lists, runs and writes", () => {
    expect(classifySection("cat a.ts | head -60")).toBe("read")
    expect(classifySection("sed -n 1,80p server/routes/config.ts")).toBe("read")
    expect(classifySection('grep -rn "foo" src | head -5')).toBe("search")
    expect(classifySection("ls src/components | grep -i dialog")).toBe("list")
    expect(classifySection("bun run test 2>&1 | tail -3")).toBe("run")
    expect(classifySection("bunx tsc --noEmit")).toBe("run")
    expect(classifySection("cat > server/x.ts <<'EOF'\nimport { grep } from 'x'\nEOF")).toBe("write")
    expect(classifySection("sed -i '' 's/a/b/' x.ts")).toBe("write")
    expect(classifySection("python3 - <<'EOF'\nprint(1)\nEOF")).toBe("write")
    expect(classifySection("grep -rl foo src | xargs sed -i '' 's/a/b/'")).toBe("write")
    expect(classifySection("git commit -m x")).toBe("write")
    expect(classifySection("git status")).toBe("run")
    expect(classifySection("ls > /dev/null; cat x 2>/dev/null")).toBe("list")
    expect(classifySection("grep -rniE 'claude\\.exe|cliPath' server --include='*.ts' | grep -v __tests__ | head -60")).toBe("search")
    expect(classifySection('grep -rn "a\\|b; rm -rf x" src')).toBe("search")
  })

  it("extracts path-shaped tokens without globs or flags", () => {
    expect(extractPaths('grep -rn "configWrite" src/lib shared | head -5')).toEqual(["src/lib"])
    expect(extractPaths("sed -n 1,80p src/components/ConfigDialog/NetworkAccessSection.tsx")).toEqual([
      "src/components/ConfigDialog/NetworkAccessSection.tsx",
    ])
    expect(extractPaths("ls node_modules/@a/sdk-*/ && cat package.json && cat --include='*.ts' ~/.cogpit/port")).toEqual([
      "package.json",
      "~/.cogpit/port",
    ])
    expect(extractPaths("cat > server/x.ts <<'EOF'\nimport a from './b/c.ts'\nEOF")).toEqual(["server/x.ts"])
    expect(extractPaths('grep -n "hot-swap" server/lib/cliProcess.ts:')).toEqual(["server/lib/cliProcess.ts"])
  })

  it("recognises a plain single-file read and its sed range", () => {
    expect(readFileTarget("cat src/a.tsx")).toEqual({ path: "src/a.tsx" })
    expect(readFileTarget("sed -n 320,460p server/routes/config.ts")).toEqual({
      path: "server/routes/config.ts",
      from: 320,
      to: 460,
    })
    expect(readFileTarget("cat server/lib/pushConfig.ts | head -60")).toEqual({ path: "server/lib/pushConfig.ts" })
    expect(readFileTarget("cat a.ts b.ts")).toBeNull()
    expect(readFileTarget("cat a.ts | grep foo")).toBeNull()
  })

  it("flags shell failures the ; chain swallowed, but not error-shaped file content", () => {
    expect(detectFailure("read", "cat: nope.ts: No such file or directory")).toBe(true)
    expect(detectFailure("search", "(eval):1: no matches found: src/lib/router*.ts")).toBe(true)
    expect(detectFailure("run", "error: script \"test\" exited with code 1")).toBe(true)
    expect(detectFailure("read", "line1\nline2\nthrow new Error('No such file or directory')\nline4\nline5")).toBe(false)
    expect(detectFailure("search", "src/a.ts:3: // error: handled")).toBe(false)
    expect(detectFailure("run", null)).toBe(false)
  })
})
