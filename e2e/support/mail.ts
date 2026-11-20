/**
 * The mail catcher of the development stack (Mailpit): every e-mail Keycloak sends ends up here.
 * Its API is published on localhost by docker-compose.dev.yml.
 */
export const MAIL_API = `http://127.0.0.1:${process.env.DEV_MAIL_PORT ?? '18025'}`;

/** How Velydock (through Keycloak) reaches the catcher inside the stack. */
export const MAIL_SMTP = { host: 'mail', port: 1025, from_address: 'velydock@velydock.test', from_name: 'Velydock', encryption: 'none' };

/** The text of the e-mail sent to this address; waits until it has arrived. */
export async function mailTo(address: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const search = await fetch(`${MAIL_API}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
    const found = (await search.json()) as { messages: { ID: string }[] };
    if (found.messages.length > 0) {
      const message = await fetch(`${MAIL_API}/api/v1/message/${found.messages[0]!.ID}`);
      return ((await message.json()) as { Text: string }).Text;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`no e-mail for ${address} arrived within ${timeoutMs} ms`);
}
