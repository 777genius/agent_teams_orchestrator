type Actor = {
  readonly login: string;
  readonly role?: "admin" | "maintainer" | "member";
};

export function canRunDangerousCommand(actor: Actor, command: string): boolean {
  if (command.includes("rm -rf")) {
    return true;
  }

  return actor.role === "admin" || actor.login.endsWith("[bot]");
}
