import { useState, type FormEvent } from "react";
import { api } from "./lib/api";

export function ForgotPasswordPage() {
  const [username, setUsername] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !recoveryEmail.trim()) {
      setError("Enter your username and recovery email.");
      return;
    }
    setError(null);
    try {
      await api.auth.forgotPassword({ username: username.trim(), recoveryEmail: recoveryEmail.trim() });
      setSubmitted(true);
    } catch {
      setError("Could not submit the request. Try again.");
    }
  };

  return (
    <main className="login-page">
      <div className="login-shell">
        <a className="login-wordmark" href="/" aria-label="Samryetha home">Samryetha</a>
        <section className="login-card">
          <div className="login-card-content">
            <header className="login-heading"><h1>Reset your password</h1><p>Enter your username and the recovery email you set on your account.</p></header>
            {submitted ? (
              <div className="empty-state">
                <p>If an account with that recovery email exists, a reset link has been sent. Otherwise, contact an administrator.</p>
                <p><a className="sender" href="/login">Back to sign in</a></p>
              </div>
            ) : (
              <form className="login-form" onSubmit={submit} noValidate>
                <label className="login-field"><span>Username</span><input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></label>
                <label className="login-field"><span>Recovery email</span><input type="email" autoComplete="email" value={recoveryEmail} onChange={(e) => setRecoveryEmail(e.target.value)} placeholder="you@example.com" /></label>
                {error && <small className="login-error form-error" role="alert">{error}</small>}
                <button className="login-primary" type="submit">Send reset link</button>
              </form>
            )}
            <p className="login-register">Remember your password? <a href="/login">Sign in</a></p>
          </div>
        </section>
      </div>
    </main>
  );
}
