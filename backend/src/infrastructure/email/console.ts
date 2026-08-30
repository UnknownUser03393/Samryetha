import type { Mailer } from "./types.js";

/** dev：把邮件结构打到日志，便于本地断言。 */
export class ConsoleMailer implements Mailer {
  constructor(private readonly log: (line: string) => void = (l) => console.log(l)) {}

  async send(input: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    this.log(
      `[mail] to=${input.to} subject=${JSON.stringify(input.subject)}\n${input.text}`,
    );
  }
}
