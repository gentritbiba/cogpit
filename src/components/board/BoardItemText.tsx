const LINK = /(https?:\/\/[^\s)]+)/g
const LEAD = /^([^:]{2,40}):\s+(\S[\s\S]*)$/

/** A board item, its "Subject: detail" subject set in bold and its links live. */
export function BoardItemText({ text }: { text: string }) {
  const lead = LEAD.exec(text)
  if (!lead) return <>{linkify(text)}</>
  return <><span className="font-medium text-foreground">{lead[1]}</span>: {linkify(lead[2])}</>
}

function linkify(text: string) {
  return text.split(LINK).map((part, index) => (index % 2 === 1
    ? <a key={index} href={part} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">{part}</a>
    : part))
}
