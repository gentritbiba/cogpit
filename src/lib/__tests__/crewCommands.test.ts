import { describe, expect, it } from "vitest"
import { crewCallSentence, describeCrewCall, parseCrewInvocations, startDetails, startedIds, startMessage, startsCrewSession } from "../crewCommands"

const LANE = "01a11695-2938-7ec2-9d9c-0c8af023bd5f"
const OTHER = "253c3558-5ef4-40ed-8a58-755f4891dbd0"

describe("parseCrewInvocations", () => {
  it("ignores escaped shell operators in literal arguments", () => {
    expect(parseCrewInvocations(String.raw`echo \; cogpit-session new hi`)).toEqual([])
    expect(parseCrewInvocations(String.raw`echo \| cogpit-session stop x`)).toEqual([])
    expect(parseCrewInvocations(String.raw`echo \# cogpit-session new hi`)).toEqual([])
  })
  it("reads the verb, flags and arguments of every invocation, quoted or not", () => {
    const command = `cd ~/hcms-pr/w3-ops-tooling && cogpit-session new - --agent codex --mode plan --cwd "$(pwd -P)" --name "Code review: W3ops-r1" < ~/hcms-pr/reviews/packet.md | tee out.json`
    expect(parseCrewInvocations(command)).toEqual([{
      verb: "new",
      args: ["-"],
      flags: { agent: "codex", mode: "plan", cwd: "$(pwd -P)", name: "Code review: W3ops-r1" },
      switches: [],
      at: command.indexOf("cogpit-session") + "cogpit-session".length,
    }])
  })

  it("finds the CLI by path, inside $(…), and in wait loops", () => {
    const command = [
      `~/.cogpit/bin/cogpit-session send ${LANE} - --command-id ps-r8-$(date +%s) < msg.md 2>&1 | grep delivery`,
      `until ~/.cogpit/bin/cogpit-session wait ${LANE} --timeout 90 > /tmp/r.json; [ $? -ne 3 ]; do :; done`,
      `A=$(cogpit-session new "Audit the API routes" --worktree=audit-api --wait | jq -r .sessionId)`,
    ].join("\n")
    expect(parseCrewInvocations(command).map(({ verb, args, flags, switches }) => ({ verb, args, flags, switches }))).toEqual([
      { verb: "send", args: [LANE, "-"], flags: { "command-id": "ps-r8-$(date +%s)" }, switches: [] },
      { verb: "wait", args: [LANE], flags: { timeout: "90" }, switches: [] },
      { verb: "new", args: ["Audit the API routes"], flags: { worktree: "audit-api" }, switches: ["wait"] },
    ])
  })

  it("ignores text that only mentions the CLI", () => {
    expect(parseCrewInvocations(`grep -n "cogpit-session wait" notes.md`)).toEqual([])
    expect(parseCrewInvocations(`echo use cogpit-sessions skill`)).toEqual([])
    expect(parseCrewInvocations(`echo "use cogpit-session stop --children"`)).toEqual([])
    expect(parseCrewInvocations(`echo 'cogpit-session new x'; ls`)).toEqual([])
    expect(parseCrewInvocations(`ls # then cogpit-session stop --children`)).toEqual([])
  })

  it("skips heredoc bodies and reads the commands after them", () => {
    const command = [
      `cat > brief.md <<'EOF'`,
      `First run cogpit-session new "x" --name ghost`,
      `EOF`,
      `cogpit-session new - --name real < brief.md`,
    ].join("\n")
    expect(parseCrewInvocations(command).map(({ verb, flags }) => [verb, flags.name])).toEqual([["new", "real"]])
  })

  it("finds the CLI by a quoted path, after assignments and keywords", () => {
    const id = "01a11695-2938-7ec2-9d9c-0c8af023bd5f"
    expect(parseCrewInvocations(`"$HOME/.cogpit/bin/cogpit-session" status ${id}`).map(({ verb }) => verb)).toEqual(["status"])
    expect(parseCrewInvocations(`'/home/me/.cogpit/bin/cogpit-session' stop ${id}`).map(({ verb }) => verb)).toEqual(["stop"])
    expect(parseCrewInvocations(`COGPIT_PORT=19385 cogpit-session children`).map(({ verb }) => verb)).toEqual(["children"])
    expect(parseCrewInvocations(`if cogpit-session wait ${id}; then echo done; fi`).map(({ verb }) => verb)).toEqual(["wait"])
    expect(parseCrewInvocations(`echo "$(cogpit-session result ${id} --text)"`).map(({ verb }) => verb)).toEqual(["result"])
  })
})

describe("describeCrewCall", () => {
  it("preserves scoped session IDs and ignores account UUID fields in start results", () => {
    const instance = "12345678-1234-4234-8234-123456789012"
    const scoped = `i-${instance}__${btoa(LANE)}`
    expect(describeCrewCall(`cogpit-session send ${scoped} hello`, null)?.sessionIds).toEqual([scoped])
    expect(describeCrewCall("cogpit-session new hello", JSON.stringify({ sessionId: scoped, instanceId: instance, dirName: "-repo", next: `cogpit-session wait ${scoped}` }))?.sessionIds).toEqual([scoped])
  })
  it("names a started session from its flags and the id from its result", () => {
    const call = describeCrewCall(
      `cogpit-session new - --cwd ~/hcms-pr/w3-perf-ship --agent claude --model claude-opus-5-5 --effort high --name w3-perf-ship < brief.md`,
      `{\n  "sessionId": "${LANE}",\n  "dirName": "-Users-me-hcms-pr-w3-perf-ship",\n  "next": "cogpit-session wait ${LANE}"\n}`,
    )
    expect(call).toMatchObject({ verb: "new", count: 1, sessionIds: [LANE], names: ["w3-perf-ship"], details: ["Opus 5.5", "high"] })
    expect(crewCallSentence(call!, () => undefined)).toBe("Started w3-perf-ship · Opus 5.5 · high")
  })

  it("counts several starts in one command", () => {
    const command = ["lane-a", "lane-b", "lane-c"].map((name) => `cogpit-session new "Do ${name}" --name ${name} --worktree ${name}`).join("; ")
    const call = describeCrewCall(command, null)
    expect(call).toMatchObject({ verb: "new", count: 3, names: ["lane-a", "lane-b", "lane-c"] })
    expect(crewCallSentence(call!, () => undefined)).toBe("Started 3 sessions")
  })

  it("leads with the most consequential verb and reads outcomes from a wait", () => {
    const command = `cogpit-session send ${LANE} "rebase" ; cogpit-session wait ${LANE} ${OTHER} --timeout 600`
    const call = describeCrewCall(command, `{"timedOut":false,"sessions":[{"outcome":"completed"},{"outcome":"needs_input"}]}`)
    expect(call?.verb).toBe("send")
    expect(crewCallSentence(call!, (id) => (id === LANE ? "w3-rooftop" : undefined))).toBe("Messaged w3-rooftop")

    const wait = describeCrewCall(`cogpit-session wait ${LANE} ${OTHER} --timeout 600`, `{"sessions":[{"outcome":"completed"},{"outcome":"needs_input"}]}`)
    expect(crewCallSentence(wait!, () => undefined)).toBe("Waited on 2 sessions · 1 finished · 1 needs input")
  })

  it("says what the answers and stops did", () => {
    const named = (id: string) => (id === LANE ? "w3-rooftop" : undefined)
    expect(crewCallSentence(describeCrewCall(`cogpit-session approve ${LANE} --always`, null)!, named)).toBe("Approved w3-rooftop's request for the rest of its session")
    expect(crewCallSentence(describeCrewCall(`cogpit-session deny ${LANE} --feedback "smaller steps"`, null)!, named)).toBe("Denied w3-rooftop's request")
    expect(crewCallSentence(describeCrewCall(`cogpit-session answer ${LANE} Blue`, null)!, named)).toBe("Answered w3-rooftop")
    expect(crewCallSentence(describeCrewCall(`cogpit-session stop --children`, null)!, named)).toBe("Stopped every session it started")
    expect(crewCallSentence(describeCrewCall(`cogpit-session result ${OTHER} --text`, null)!, named)).toBe("Read 253c3558's result")
  })

  it("is null for a command that runs no crew verb", () => {
    expect(describeCrewCall("git status", null)).toBeNull()
    expect(describeCrewCall("cogpit-session help", null)).toBeNull()
  })
})

describe("startedIds", () => {
  const started = (sessionId: string) => JSON.stringify({ sessionId, dirName: "-repo", next: `cogpit-session wait ${sessionId}` })

  it("lists the sessions a command started, in order and once each", () => {
    const command = 'cogpit-session new --name a "one"; cogpit-session new --name b "two"'
    expect(startedIds([started(LANE), started(OTHER), started(LANE)].join("\n"), command)).toEqual([LANE, OTHER])
  })

  it("never counts a session another verb in the command printed", () => {
    const status = JSON.stringify({ sessionId: OTHER, outcome: "running" })
    expect(startedIds(`${status}\n${started(LANE)}`, `cogpit-session status ${OTHER}; cogpit-session new --name lane-b "x"`)).toEqual([LANE])
    expect(startedIds(JSON.stringify({ sessionId: OTHER, outcome: "completed" }), `cogpit-session wait ${OTHER}`)).toEqual([])
  })

  it("keeps every start in its own slot when one of them cannot be linked", () => {
    const children = JSON.stringify({ sessionId: OTHER, children: [] })
    const command = "cogpit-session children; cogpit-session new --wait --name first --agent codex one; cogpit-session new --name second two"
    const output = [children, JSON.stringify({ sessionId: "11111111-2222-4333-8444-555555555555", outcome: "completed" }), started(LANE)].join("\n")
    expect(startedIds(output, command)).toEqual([undefined, LANE])
  })

  it("leaves starts unlinked when the output does not hold one session per start", () => {
    expect(startedIds(started(LANE), 'cogpit-session new --name a "x"; cogpit-session new --name b "y"')).toEqual([undefined, undefined])
  })

  it("keeps mixed --wait and plain starts in the order they ran", () => {
    const command = 'cogpit-session new --wait --name a "x"; cogpit-session new --name b "y"'
    const output = `${JSON.stringify({ sessionId: LANE, outcome: "completed" })}\n${started(OTHER)}`
    expect(startedIds(output, command)).toEqual([LANE, OTHER])
  })

  it("never takes the caller's own id from a children listing for a start", () => {
    const children = JSON.stringify({ sessionId: OTHER, children: [] })
    expect(startedIds(`${children}\n${started(LANE)}`, "cogpit-session children; cogpit-session new --name audit work")).toEqual([LANE])
  })

  it("leaves a --wait start unlinked beside another verb whose report could be mistaken for it", () => {
    const status = JSON.stringify({ sessionId: OTHER, outcome: "running" })
    const report = JSON.stringify({ sessionId: LANE, outcome: "completed" })
    expect(startedIds(`${status}\n${report}`, 'cogpit-session status "$COGPIT_SESSION_ID"; cogpit-session new --wait --name audit work')).toEqual([undefined])
  })

  it("reads a --wait start from its report", () => {
    expect(startedIds(JSON.stringify({ sessionId: LANE, outcome: "completed" }), 'cogpit-session new --wait --name a "x"')).toEqual([LANE])
  })

  it("is empty before the start returns, and unlinked when it printed no session", () => {
    expect(startedIds(null, 'cogpit-session new "x"')).toEqual([])
    expect(startedIds("Error: not logged in", 'cogpit-session new "x"')).toEqual([undefined])
  })
})

describe("startDetails", () => {
  it("names the model, effort, worktree, machine and read-only mode a start asked for", () => {
    const [start] = parseCrewInvocations("cogpit-session new hi --model claude-opus-5-5 --effort high --worktree lane --device agentbox --mode plan")
    expect(startDetails(start!)).toEqual(["Opus 5.5", "high", "worktree lane", "on agentbox", "read-only"])
  })

  it("falls back to the provider's name when no model was given", () => {
    const [start] = parseCrewInvocations("cogpit-session new hi --agent codex")
    expect(startDetails(start!)).toEqual(["Codex"])
  })
})

describe("startMessage", () => {
  function brief(command: string): string {
    const start = parseCrewInvocations(command).find((invocation) => invocation.verb === "new")
    if (!start) throw new Error(`no start in ${command}`)
    return startMessage(start, command)
  }

  it("gives each start in a command its own stdin brief", () => {
    const command = [
      "cat <<'EOF' | cogpit-session new - --name a",
      "First brief",
      "EOF",
      "cat <<'EOF' | cogpit-session new - --name b",
      "Second brief",
      "EOF",
    ].join("\n")
    expect(parseCrewInvocations(command).map((start) => startMessage(start, command))).toEqual(["First brief", "Second brief"])
  })

  it("reads a heredoc the start opens itself", () => {
    expect(brief("cogpit-session new - --name a <<'EOF'\nOwn brief\nEOF")).toBe("Own brief")
  })

  it("reads a positional message as it was given", () => {
    expect(brief(`cogpit-session new "Fix the flaky test" --name flaky`)).toBe("Fix the flaky test")
  })

  it("reads the body of an inline $(cat <<'EOF' … EOF) heredoc, not the shell around it", () => {
    const command = [
      `cogpit-session new "$(cat <<'EOF'`,
      "Audit the API routes.",
      "",
      "Report what you find.",
      "EOF",
      `)" --name audit --agent codex`,
    ].join("\n")
    expect(brief(command)).toBe("Audit the API routes.\n\nReport what you find.")
  })

  it("reads a brief the same command wrote to a file and fed in on stdin", () => {
    const command = [
      "cat > /tmp/brief.md <<'EOF'",
      "Rewrite the pricing copy.",
      "EOF",
      "cogpit-session new - --name pricing < /tmp/brief.md",
    ].join("\n")
    expect(brief(command)).toBe("Rewrite the pricing copy.")
  })

  it("reads a heredoc piped into the start", () => {
    const command = [
      `cat <<'EOF' | cogpit-session new - --name docs`,
      "Write the release notes.",
      "EOF",
    ].join("\n")
    expect(brief(command)).toBe("Write the release notes.")
  })

  it("reads $(cat file) when the same command wrote that file", () => {
    const command = [
      `cat > brief.md <<"BRIEF"`,
      "Port the parser.",
      "BRIEF",
      `cogpit-session new "$(cat brief.md)" --name port`,
    ].join("\n")
    expect(brief(command)).toBe("Port the parser.")
  })

  it("comes back empty for a brief read from a file the command did not write", () => {
    expect(brief(`cogpit-session new "$(cat ~/briefs/lane.md)" --name lane`)).toBe("")
    expect(brief(`cogpit-session new - --name lane < ~/briefs/lane.md`)).toBe("")
  })

  it("does not read a file-descriptor redirect as part of the message", () => {
    const command = `cogpit-session new --name a "Fix the flaky test" 2>&1 | tee start.json`
    expect(parseCrewInvocations(command)[0]?.args).toEqual(["Fix the flaky test"])
    expect(brief(command)).toBe("Fix the flaky test")
  })

  it("keeps each start's own heredoc when another file was written first", () => {
    const command = [
      "cat > /tmp/notes.md <<'EOF'",
      "Unrelated notes.",
      "EOF",
      "cat > /tmp/brief.md <<'EOF'",
      "The real brief.",
      "EOF",
      "cogpit-session new - --name lane < /tmp/brief.md",
    ].join("\n")
    expect(brief(command)).toBe("The real brief.")
  })
})

describe("startsCrewSession", () => {
  const shell = (command: string, result: string | null = null) => ({ input: { command }, result })

  it("is true for a shell call that starts sessions", () => {
    expect(startsCrewSession(shell(`cogpit-session new "Audit" --name audit`))).toBe(true)
    expect(startsCrewSession(shell(`cogpit-session send ${LANE} hi; cogpit-session new "Audit"`))).toBe(true)
  })

  it("is false for other crew verbs, other commands and calls without a command", () => {
    expect(startsCrewSession(shell(`cogpit-session wait ${LANE}`))).toBe(false)
    expect(startsCrewSession(shell(`echo "cogpit-session new x"`))).toBe(false)
    expect(startsCrewSession(shell("git status"))).toBe(false)
    expect(startsCrewSession({ input: { file_path: "/repo/a.ts" }, result: "ok" })).toBe(false)
  })
})
