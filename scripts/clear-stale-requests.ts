// Declines join requests that were waiting before Kitan took over a group.
//
// A request nobody answers stops the person from asking again, and a bot cannot
// see requests that arrived while it was offline: listing and hiding pending
// requests are user-only Telegram methods. So a group admin runs this with their
// own account. Declined people can ask again at once, and Kitan checks them.
//
//   TG_API_ID=… TG_API_HASH=… bun scripts/clear-stale-requests.ts --before 2026-11-10T15:07:00Z
//   … --apply      actually decline (without it, only lists what would be declined)
//
// API id and hash: https://my.telegram.org → API development tools.
// The login is kept in ~/.config/kitan/admin.session (readable only by you).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const beforeArg = args[args.indexOf("--before") + 1];
const before = Date.parse(beforeArg ?? "");
if (!args.includes("--before") || Number.isNaN(before)) {
  console.error("Pass --before <ISO time>: when Kitan started answering your groups' join requests.");
  process.exit(2);
}
const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH ?? "";
if (!apiId || !apiHash) {
  console.error("Set TG_API_ID and TG_API_HASH (from https://my.telegram.org).");
  process.exit(2);
}

const dir = join(homedir(), ".config", "kitan");
const sessionFile = join(dir, "admin.session");
const session = new StringSession(existsSync(sessionFile) ? readFileSync(sessionFile, "utf8").trim() : "");
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
const rl = createInterface({ input: process.stdin, output: process.stdout });
await client.start({
  phoneNumber: () => rl.question("Phone number (with country code): "),
  phoneCode: () => rl.question("Login code Telegram sent you: "),
  password: () => rl.question("Two-step verification password: "),
  onError: (error) => console.error(error.message),
});
rl.close();
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(sessionFile, String(client.session.save()), { mode: 0o600 });
chmodSync(sessionFile, 0o600);

let total = 0;
for await (const dialog of client.iterDialogs({})) {
  const entity = dialog.entity;
  if (!(entity instanceof Api.Channel || entity instanceof Api.Chat)) continue;
  if (!entity.adminRights?.inviteUsers && !entity.creator) continue;

  const full =
    entity instanceof Api.Channel
      ? (await client.invoke(new Api.channels.GetFullChannel({ channel: entity }))).fullChat
      : (await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }))).fullChat;
  if (!full.requestsPending) continue;

  const stale = await staleRequests(entity, before);
  console.log(`${dialog.title}: ${full.requestsPending} waiting, ${stale.length} from before ${beforeArg}`);
  total += stale.length;
  if (!apply) continue;
  for (const user of stale) {
    await client.invoke(new Api.messages.HideChatJoinRequest({ peer: entity, userId: user, approved: false }));
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.log(`  declined ${stale.length}`);
}
console.log(apply ? `Done: declined ${total}.` : `Would decline ${total}. Run again with --apply to do it.`);
await client.disconnect();
process.exit(0);

// Pending requesters older than `cutoff`, as entities the hide call accepts. Telegram
// returns requests newest first, paged by (date, user) of the last one seen.
async function staleRequests(peer: Api.Channel | Api.Chat, cutoff: number): Promise<Api.User[]> {
  const found: Api.User[] = [];
  let offsetDate = 0;
  let offsetUser: Api.TypeEntityLike = new Api.InputUserEmpty();
  for (;;) {
    const page: Api.messages.ChatInviteImporters = await client.invoke(
      new Api.messages.GetChatInviteImporters({ requested: true, peer, offsetDate, offsetUser, limit: 100 }),
    );
    const users = new Map<string, Api.TypeUser>(page.users.map((u: Api.TypeUser) => [u.id.toString(), u]));
    for (const importer of page.importers) {
      const user = users.get(importer.userId.toString());
      if (user instanceof Api.User && importer.date * 1000 < cutoff) found.push(user);
    }
    const last = page.importers.at(-1);
    if (!last || page.importers.length < 100) return found;
    offsetDate = last.date;
    offsetUser = users.get(last.userId.toString()) ?? new Api.InputUserEmpty();
  }
}
