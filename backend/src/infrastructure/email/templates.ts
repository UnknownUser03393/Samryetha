export function verificationEmail(input: { code: string; displayName: string }): {
  subject: string;
  text: string;
} {
  return {
    subject: "Verify your Samryetha account",
    text: `Hi ${input.displayName},\n\nYour verification code is:\n\n  ${input.code}\n\nIt expires in 15 minutes.`,
  };
}

export function passwordResetEmail(input: { link: string; displayName: string }): {
  subject: string;
  text: string;
} {
  return {
    subject: "Reset your Samryetha password",
    text: `Hi ${input.displayName},\n\nClick the link below to reset your password (expires in 1 hour):\n\n${input.link}`,
  };
}

export function banNotificationEmail(input: { reason?: string; bannedUntil: number | null }): {
  subject: string;
  text: string;
} {
  const untilText = input.bannedUntil
    ? `until ${new Date(input.bannedUntil).toISOString()}`
    : "permanently";
  return {
    subject: "Your Samryetha account has been suspended",
    text: `Your account has been suspended ${untilText}.\n${input.reason ? `Reason: ${input.reason}` : ""}`,
  };
}
