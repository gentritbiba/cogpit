import { describe, expect, it } from "vitest"
import { crewCallSentence, describeCrewCall, parseCrewInvocations } from "../crewCommands"

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
    expect(describeCrewCall("cogpit-session new hello", JSON.stringify({ sessionId: scoped, instanceId: instance }))?.sessionIds).toEqual([scoped])
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
