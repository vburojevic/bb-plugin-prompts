// Quick replies: what a reply asks for, so each chip can show an icon for it.
//
// The model names a topic for its own replies. The user's habits, snippets
// and own chips have none, so their topic comes from their words. A reply
// that matches no rule keeps its source's icon.

/** Each topic with the gloss the model reads to pick it. */
const TOPIC_GLOSSES = {
  continue: "keep going with the work",
  status: "ask how far along it is",
  done: "ask whether it is finished",
  yes: "approve or agree",
  no: "decline or stop something",
  ask: "have the agent ask the user first",
  explain: "explain how or why",
  test: "write or run tests",
  fix: "fix a bug or failure",
  error: "throw, handle or report errors",
  run: "run, build or start something",
  commit: "commit or push",
  pr: "open or merge a pull request",
  branch: "branch, rebase or check out",
  review: "review, check or verify",
  search: "find, look into or investigate",
  release: "release, ship or deploy",
  docs: "write or update docs",
  visual: "show a screenshot or change the UI",
  plan: "plan before doing",
  refactor: "change or restructure the code",
  undo: "revert or undo",
  delete: "delete or remove",
  summary: "summarize",
  wait: "wait or pause",
  speed: "make it faster",
  install: "install, update or bump",
} as const;

export type ReplyTopic = keyof typeof TOPIC_GLOSSES;

export const REPLY_TOPICS = Object.keys(TOPIC_GLOSSES) as ReplyTopic[];

/** "continue (keep going with the work), status (…), …" for the model. */
export const REPLY_TOPIC_LIST = REPLY_TOPICS.map((topic) => `${topic} (${TOPIC_GLOSSES[topic]})`).join(", ");

const TOPICS: ReadonlySet<string> = new Set(REPLY_TOPICS);

export function isReplyTopic(value: unknown): value is ReplyTopic {
  return typeof value === "string" && TOPICS.has(value);
}

/**
 * Words that name a topic, the most specific first: "run the tests" is
 * about tests, "fix the failing build" is a fix, "use ask mode" is about
 * asking. Each pattern matches whole words in the lowercased text.
 */
const RULES: readonly [ReplyTopic, RegExp][] = [
  // A reply that opens with a no is a no, whatever it names after.
  ["no", /^(?:no|nope|don'?t|stop|cancel|skip|never ?mind)\b/],
  ["ask", /\bask (?:mode|me)\b|\bquestion tool\b|\bclarif(?:y|ying)\b/],
  ["done", /\b(?:all |are you |is it |everything )?(?:done|finished|complete)\s*\?|\ball done\b/],
  ["status", /\b(?:status|progress|eta|where are we|how far|how is it going|update me|what'?s left)\b/],
  ["continue", /\b(?:continue|keep going|go on|carry on|resume|proceed|next step)\b/],
  ["undo", /\b(?:revert|undo|roll ?back|reset)\b/],
  ["delete", /\b(?:delete|remove|drop|get rid of)\b/],
  ["release", /\b(?:release|deploy|ship|publish|testflight|tag)\b/],
  ["pr", /\b(?:pr|prs|pull request|merge)\b/],
  ["commit", /\b(?:commit|push|stage)\b/],
  ["branch", /\b(?:branch|rebase|checkout|worktree)\b/],
  ["test", /\b(?:tests?|specs?|coverage|e2e)\b/],
  ["fix", /\b(?:fix|bugs?|debug|broken|crash(?:es)?|failing)\b/],
  ["error", /\b(?:throws?|exceptions?|errors?)\b/],
  ["review", /\b(?:review|second look|verify|double.check|check)\b/],
  ["search", /\b(?:search|find|investigate|look into|research|grep|dig)\b/],
  ["explain", /\b(?:explain|why|how does|what does|eli5)\b/],
  ["summary", /\b(?:summari[sz]e|summary|recap|tl;?dr)\b/],
  ["plan", /\b(?:plan|todo|steps|break (?:it )?down|roadmap|spec it)\b/],
  ["visual", /\b(?:screenshots?|show me|ui|design|visual|image|mockup)\b/],
  ["docs", /\b(?:docs?|readme|document|changelog|notes|comments?)\b/],
  ["refactor", /\b(?:refactor|simplify|clean ?up|tidy|polish)\b/],
  ["speed", /\b(?:faster|perf|performance|speed|optimi[sz]e|slow)\b/],
  ["install", /\b(?:install|update|upgrade|bump)\b/],
  ["run", /\b(?:run|build|start|launch|compile|execute)\b/],
  ["wait", /\b(?:wait|pause|hold|later)\b/],
  // A yes that names a step ("yes, ship it") shows the step.
  ["yes", /^(?:yes|yep|yeah|ok|okay|sure|approved?|go ahead|sounds good|do it|lgtm|agreed)\b/],
];

/** The topic a reply's words name, or null when none fits. */
export function topicOf(text: string): ReplyTopic | null {
  const words = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!words) return null;
  for (const [topic, pattern] of RULES) if (pattern.test(words)) return topic;
  return null;
}
