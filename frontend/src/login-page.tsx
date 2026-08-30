import { type AnimationEvent, type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError } from "./lib/api";
import { useAuth } from "./lib/auth";
import { EyeIcon } from "./icons";

export type AuthMode = "login" | "register" | "forgot";
type FieldErrors = Record<string, string | undefined>;

const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export function LoginPage({ mode, onSignedIn }: { mode: AuthMode; onSignedIn: () => void }) {
  const { refresh } = useAuth();
  const [displayedMode, setDisplayedMode] = useState<AuthMode>(mode);
  const [phase, setPhase] = useState<"" | "is-leaving" | "is-entering">("");
  const [cardHeight, setCardHeight] = useState<number>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [registerEmail, setRegisterEmail] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [verifyPhase, setVerifyPhase] = useState(false);
  const [code, setCode] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [autofilled, setAutofilled] = useState<Record<string, boolean>>({});
  const [resetSent, setResetSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const transitionToken = useRef(0);

  useEffect(() => {
    if (mode === displayedMode) return;
    setErrors({});
    setResetSent(false);
    setVerifyPhase(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplayedMode(mode);
      return;
    }
    const token = ++transitionToken.current;
    setPhase("is-leaving");
    const timer = window.setTimeout(() => {
      if (token !== transitionToken.current) return;
      setDisplayedMode(mode);
      setPhase("is-entering");
      requestAnimationFrame(() => setPhase(""));
    }, 125);
    return () => window.clearTimeout(timer);
  }, [displayedMode, mode]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setCardHeight(content.scrollHeight + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [displayedMode, errors, resetSent, verifyPhase]);

  const detectAutofill = (field: string, setValue: (value: string) => void) => (event: AnimationEvent<HTMLInputElement>) => {
    if (event.animationName !== "on-autofill-start") return;
    setAutofilled((current) => ({ ...current, [field]: true }));
    setValue(event.currentTarget.value);
  };
  const clearError = (field: string) => { if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined })); };
  const inputClass = (field: string) => autofilled[field] ? "is-autofilled" : "";

  // 后端统一错误 → 字段级/表单级错误
  const applyApiError = (err: unknown, fieldMap: Record<string, string>) => {
    if (err instanceof ApiError) {
      if (err.code === "VALIDATION_ERROR" && Array.isArray(err.details)) {
        const next: FieldErrors = {};
        for (const d of err.details as { field: string; message: string }[]) {
          next[fieldMap[d.field] ?? d.field] = d.message;
        }
        setErrors(next);
      } else if (err.code === "INVALID_CREDENTIALS" || err.code === "AUTH_REQUIRED") {
        setErrors({ password: err.message });
      } else {
        setErrors({ form: err.message });
      }
    } else {
      setErrors({ form: "Something went wrong. Try again." });
    }
  };

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: FieldErrors = {};
    if (!email.trim()) next.email = "Enter your school email.";
    else if (!validEmail(email)) next.email = "That email address doesn’t look right.";
    if (!password) next.password = "Enter your password.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSubmitting(true);
    try {
      await api.auth.login({ email: email.trim(), password });
      await refresh();
      onSignedIn();
    } catch (err) {
      applyApiError(err, {});
    } finally {
      setSubmitting(false);
    }
  };

  const submitRegister = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: FieldErrors = {};
    if (!displayName.trim()) next.displayName = "Enter the name people should see.";
    if (!username.trim()) next.username = "Choose a username.";
    else if (!/^[a-z0-9_]{3,30}$/i.test(username.trim())) next.username = "3-30 letters, numbers, or underscores.";
    if (!registerEmail.trim()) next.registerEmail = "Enter your school email.";
    else if (!validEmail(registerEmail)) next.registerEmail = "That email address doesn’t look right.";
    if (registerPassword.length < 8) next.registerPassword = "Use at least 8 characters.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSubmitting(true);
    try {
      await api.auth.register({
        email: registerEmail.trim(),
        username: username.trim(),
        displayName: displayName.trim(),
        password: registerPassword,
      });
      setVerifyPhase(true);
    } catch (err) {
      applyApiError(err, { username: "username", displayName: "displayName", email: "registerEmail" });
    } finally {
      setSubmitting(false);
    }
  };

  const submitVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (code.trim().length < 6) {
      setErrors({ code: "Enter the 6-digit code." });
      return;
    }
    setSubmitting(true);
    try {
      await api.auth.verifyEmail({ email: registerEmail.trim(), code: code.trim() });
      await refresh();
      onSignedIn();
    } catch (err) {
      applyApiError(err, {});
    } finally {
      setSubmitting(false);
    }
  };

  const resendCode = async () => {
    setSubmitting(true);
    try {
      await api.auth.resendVerification(registerEmail.trim());
      setErrors({});
    } catch (err) {
      applyApiError(err, {});
    } finally {
      setSubmitting(false);
    }
  };

  const submitReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: FieldErrors = {};
    if (!resetEmail.trim()) next.resetEmail = "Enter your school email.";
    else if (!validEmail(resetEmail)) next.resetEmail = "That email address doesn’t look right.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSubmitting(true);
    try {
      await api.auth.forgotPassword(resetEmail.trim());
      setResetSent(true);
    } catch (err) {
      applyApiError(err, { email: "resetEmail" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-shell">
        <a className="login-wordmark" href="/" aria-label="Samryetha home">Samryetha</a>
        <section className="login-card" style={{ height: cardHeight }}>
          <div className={`login-card-content ${phase}`} ref={contentRef}>
            {displayedMode === "login" && <>
              <header className="login-heading"><h1>Welcome back</h1><p>Sign in to continue to the discussions.</p></header>
              <form className="login-form" onSubmit={submitLogin} noValidate>
                <label className="login-field"><span>Email</span><span className={`login-input-frame ${errors.email ? "invalid" : ""}`}><input className={inputClass("email")} type="email" inputMode="email" autoComplete="email" value={email} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "login-email-error" : undefined} onAnimationStart={detectAutofill("email", setEmail)} onChange={(event) => { setEmail(event.target.value); clearError("email"); }} autoFocus /></span>{errors.email && <small className="login-error" id="login-email-error">{errors.email}</small>}</label>
                <label className="login-field"><span className="login-label-row"><span>Password</span><a href="/forgot-password">Forgot password?</a></span><span className={`login-input-frame ${errors.password ? "invalid" : ""}`}><input className={inputClass("password")} type="password" autoComplete="current-password" value={password} aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? "login-password-error" : undefined} onAnimationStart={detectAutofill("password", setPassword)} onChange={(event) => { setPassword(event.target.value); clearError("password"); }} /></span>{errors.password && <small className="login-error" id="login-password-error">{errors.password}</small>}</label>
                {errors.form && <small className="login-error form-error" role="alert">{errors.form}</small>}
                <button className="login-primary" type="submit" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}</button>
              </form>
              <p className="login-register">New to Samryetha? <a href="/register">Create an account</a></p>
            </>}

            {displayedMode === "register" && !verifyPhase && <>
              <header className="login-heading"><h1>Create your account</h1><p>Join the wall with your school email.</p></header>
              <form className="login-form" onSubmit={submitRegister} noValidate>
                <label className="login-field"><span>Display name</span><span className={`login-input-frame ${errors.displayName ? "invalid" : ""}`}><input type="text" autoComplete="name" placeholder="How people will know you" value={displayName} aria-invalid={Boolean(errors.displayName)} onChange={(event) => { setDisplayName(event.target.value); clearError("displayName"); }} autoFocus /></span>{errors.displayName && <small className="login-error">{errors.displayName}</small>}</label>
                <label className="login-field"><span>Username</span><span className={`login-input-frame ${errors.username ? "invalid" : ""}`}><span className="prefixed-input"><span>@</span><input type="text" autoComplete="username" placeholder="sora" value={username} aria-invalid={Boolean(errors.username)} onChange={(event) => { setUsername(event.target.value); clearError("username"); }} /></span></span>{errors.username && <small className="login-error">{errors.username}</small>}</label>
                <label className="login-field"><span>School email</span><span className={`login-input-frame ${errors.registerEmail ? "invalid" : ""}`}><input className={inputClass("registerEmail")} type="email" inputMode="email" autoComplete="email" value={registerEmail} aria-invalid={Boolean(errors.registerEmail)} onAnimationStart={detectAutofill("registerEmail", setRegisterEmail)} onChange={(event) => { setRegisterEmail(event.target.value); clearError("registerEmail"); }} /></span>{errors.registerEmail && <small className="login-error">{errors.registerEmail}</small>}</label>
                <label className="login-field"><span>Password</span><span className={`login-input-frame has-action ${errors.registerPassword ? "invalid" : ""}`}><input className={inputClass("registerPassword")} type={passwordVisible ? "text" : "password"} autoComplete="new-password" placeholder="At least 8 characters" value={registerPassword} aria-invalid={Boolean(errors.registerPassword)} onAnimationStart={detectAutofill("registerPassword", setRegisterPassword)} onChange={(event) => { setRegisterPassword(event.target.value); clearError("registerPassword"); }} /><button className="password-visibility" type="button" aria-label={passwordVisible ? "Hide password" : "Show password"} aria-pressed={passwordVisible} onClick={() => setPasswordVisible((value) => !value)}><EyeIcon visible={passwordVisible} /></button></span>{errors.registerPassword && <small className="login-error">{errors.registerPassword}</small>}</label>
                {errors.form && <small className="login-error form-error" role="alert">{errors.form}</small>}
                <p className="register-terms">By creating an account, you agree to our <button type="button">Terms</button> and <button type="button">Privacy Policy</button>.</p>
                <button className="login-primary" type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create account"}</button>
              </form>
              <p className="login-register">Already have an account? <a href="/login">Sign in</a></p>
            </>}

            {displayedMode === "register" && verifyPhase && <>
              <a className="auth-back" href="/register" onClick={() => setVerifyPhase(false)}>← Back</a>
              <header className="login-heading"><h1>Check your email</h1><p>Enter the 6-digit code sent to <strong>{registerEmail}</strong>.</p></header>
              <form className="login-form" onSubmit={submitVerify} noValidate>
                <label className="login-field"><span>Verification code</span><span className={`login-input-frame ${errors.code ? "invalid" : ""}`}><input className={inputClass("code")} type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" value={code} maxLength={6} aria-invalid={Boolean(errors.code)} onChange={(event) => { setCode(event.target.value.replace(/\D/g, "")); clearError("code"); }} autoFocus /></span>{errors.code && <small className="login-error">{errors.code}</small>}</label>
                {errors.form && <small className="login-error form-error" role="alert">{errors.form}</small>}
                <button className="login-primary" type="submit" disabled={submitting || code.trim().length < 6}>{submitting ? "Verifying…" : "Verify email"}</button>
                <p className="login-register">Didn’t get it? <button type="button" className="resend-link" onClick={resendCode} disabled={submitting}>Resend code</button></p>
              </form>
            </>}

            {displayedMode === "forgot" && <>
              <a className="auth-back" href="/login">← Back to sign in</a>
              <header className="login-heading"><h1>Reset your password</h1></header>
              <form className="login-form" onSubmit={submitReset} noValidate>
                <label className="login-field"><span>Email</span><span className={`login-input-frame ${errors.resetEmail ? "invalid" : ""}`}><input className={inputClass("resetEmail")} type="email" inputMode="email" autoComplete="email" value={resetEmail} aria-invalid={Boolean(errors.resetEmail)} onAnimationStart={detectAutofill("resetEmail", setResetEmail)} onChange={(event) => { setResetEmail(event.target.value); setResetSent(false); clearError("resetEmail"); }} autoFocus /></span>{errors.resetEmail && <small className="login-error">{errors.resetEmail}</small>}</label>
                {errors.form && <small className="login-error form-error" role="alert">{errors.form}</small>}
                <button className="login-primary" type="submit" disabled={submitting}>{resetSent ? "Link sent" : submitting ? "Sending…" : "Send reset link"}</button>
                {resetSent && <p className="reset-confirmation" role="status">Check your inbox for the reset link.</p>}
              </form>
            </>}
          </div>
        </section>
        <p className="login-note">Use your school email, then get back to the wall.</p>
      </div>
    </main>
  );
}
