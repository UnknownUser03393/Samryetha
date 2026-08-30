import { useEffect, useRef, useState, type FormEvent } from "react";
import { AppShell } from "./app-shell";
import { useAnimatedTabs } from "./lib/use-animated-tabs";
import { useTabIndicator } from "./lib/use-tab-indicator";
import { api, ApiError } from "./lib/api";
import { useAuth } from "./lib/auth";

type SettingsSection = "account" | "notifications" | "privacy" | "appearance";

const sections: { id: SettingsSection; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "notifications", label: "Notifications" },
  { id: "privacy", label: "Privacy" },
  { id: "appearance", label: "Appearance" },
];

function Toggle({ defaultOn = false, label }: { defaultOn?: boolean; label: string }) {
  const [on, setOn] = useState(defaultOn);
  return <button className={`settings-toggle ${on ? "on" : ""}`} type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => setOn((value) => !value)}><span /></button>;
}

function SettingRow({ title, description, defaultOn = false }: { title: string; description: string; defaultOn?: boolean }) {
  return <div className="setting-row"><div><h3>{title}</h3><p>{description}</p></div><Toggle label={title} defaultOn={defaultOn} /></div>;
}

export function SettingsPage() {
  const { user } = useAuth();
  const { active: selectedSection, committed: section, phase: contentPhase, setActive: switchSection } = useAnimatedTabs<SettingsSection>({ initial: "account", duration: 125 });
  const [theme, setTheme] = useState("System");
  const settingsNavRef = useRef<HTMLElement>(null);
  const navIndicator = useTabIndicator(settingsNavRef, (s) => `[data-settings-section="${s}"]`, selectedSection);

  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [saveState, setSaveState] = useState<"" | "saving" | "saved" | "error">("");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwState, setPwState] = useState<"" | "saving" | "saved" | "error">("");
  const [pwMessage, setPwMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName);
    setUsername(user.username);
    setBio(user.bio);
  }, [user]);

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaveState("saving");
    setSaveMessage(null);
    try {
      await api.users.updateProfile({ displayName: displayName.trim(), username: username.trim(), bio: bio.trim() });
      setSaveState("saved");
      setSaveMessage("Changes saved.");
    } catch (err) {
      setSaveState("error");
      setSaveMessage(err instanceof ApiError ? err.message : "Could not save changes.");
    }
  };

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentPassword.trim()) {
      setPwState("error");
      setPwMessage("Enter your current password.");
      return;
    }
    setPwState("saving");
    setPwMessage(null);
    try {
      await api.auth.changePassword({ currentPassword, newPassword });
      setPwState("saved");
      setPwMessage("Password updated.");
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      setPwState("error");
      setPwMessage(err instanceof ApiError ? err.message : "Could not change password.");
    }
  };

  return (
    <AppShell current="settings">
      <main className="shell settings-layout">
        <aside className="settings-sidebar">
          <h1>Settings</h1>
          <nav className="settings-nav" aria-label="Settings categories" ref={settingsNavRef}>
            {sections.map((item) => <button data-settings-section={item.id} className={selectedSection === item.id ? "active" : ""} key={item.id} type="button" aria-current={selectedSection === item.id ? "page" : undefined} onClick={() => switchSection(item.id)}>{item.label}</button>)}
            <span className={`settings-nav-indicator ${navIndicator.ready ? "ready" : ""}`} style={{ width: navIndicator.width, height: navIndicator.height, transform: `translate(${navIndicator.x}px, ${navIndicator.y}px)` }} aria-hidden="true" />
            <span className={`settings-nav-accent ${navIndicator.ready ? "ready" : ""}`} style={{ transform: `translate(${navIndicator.x}px, ${navIndicator.y + 10}px)` }} aria-hidden="true" />
          </nav>
        </aside>

        <section className={`settings-content ${contentPhase}`} aria-live="polite">
          {section === "account" && <>
            <header><h2>Account</h2><p>Manage the details people see across Samryetha.</p></header>
            <form className="settings-form" onSubmit={saveProfile} noValidate>
              <div className="settings-field-grid">
                <label><span>Display name</span><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={50} /></label>
                <label><span>Username</span><div className="prefixed-input"><span>@</span><input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={30} /></div></label>
              </div>
              <label><span>Bio</span><textarea rows={4} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={500} placeholder="A sentence or two about you." /></label>
              {saveMessage && <p className={`form-error ${saveState === "saved" ? "saved-note" : ""}`} role="status">{saveMessage}</p>}
              <div className="settings-actions"><button className="primary-action" type="submit" disabled={saveState === "saving"}>{saveState === "saving" ? "Saving…" : "Save changes"}</button></div>
            </form>

            <header className="settings-sub"><h2>Password</h2><p>Set a new password for your account.</p></header>
            <form className="settings-form" onSubmit={changePassword} noValidate>
              <label><span>Current password</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>
              <label><span>New password</span><input type="password" autoComplete="new-password" placeholder="At least 8 characters" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></label>
              {pwMessage && <p className={`form-error ${pwState === "saved" ? "saved-note" : ""}`} role="status">{pwMessage}</p>}
              <div className="settings-actions"><button className="primary-action" type="submit" disabled={pwState === "saving" || !currentPassword.trim() || newPassword.length < 8}>{pwState === "saving" ? "Updating…" : "Update password"}</button></div>
            </form>
          </>}

          {section === "notifications" && <>
            <header><h2>Notifications</h2><p>Choose what is worth interrupting you for.</p></header>
            <div className="settings-group">
              <SettingRow title="Mentions and replies" description="When someone mentions you or replies to your discussion." defaultOn />
              <SettingRow title="New followers" description="When someone starts following your profile." defaultOn />
              <SettingRow title="Weekly digest" description="A quiet summary of discussions you may have missed." />
            </div>
            <p className="community-note">Preference toggles are local for now — server-side notification routing lands later.</p>
          </>}

          {section === "privacy" && <>
            <header><h2>Privacy</h2><p>Control how other people can find and contact you.</p></header>
            <div className="settings-group">
              <SettingRow title="Public profile" description="Let anyone on campus view your profile and activity." defaultOn />
              <SettingRow title="Show online status" description="Show when you are currently active." defaultOn />
              <SettingRow title="Direct messages" description="Allow other students to send you private messages." defaultOn />
            </div>
            <p className="community-note">These preferences aren’t wired to the backend yet.</p>
          </>}

          {section === "appearance" && <>
            <header><h2>Appearance</h2><p>Adjust how Samryetha looks and feels on this device.</p></header>
            <div className="settings-group">
              <div className="setting-row setting-row-stacked"><div><h3>Theme</h3><p>Use your device theme or choose one here.</p></div><div className="theme-control" role="group" aria-label="Theme">{["System", "Light", "Dark"].map((item) => <button className={theme === item ? "active" : ""} type="button" key={item} aria-pressed={theme === item} onClick={() => setTheme(item)}>{item}</button>)}</div></div>
              <SettingRow title="Reduce motion" description="Minimize page and tab transition animations." />
              <SettingRow title="Compact lists" description="Fit more discussions on screen at once." />
            </div>
          </>}
        </section>
      </main>
    </AppShell>
  );
}
