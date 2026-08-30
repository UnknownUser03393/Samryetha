/** 邮件发送抽象。dev 用 ConsoleMailer 打日志，将来换 nodemailer SMTP。 */
export interface Mailer {
  send(input: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}
