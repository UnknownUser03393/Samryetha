import { useEffect, useRef, useState } from "react";
import { useAuth } from "./lib/auth";
import { initials } from "./lib/format";
import { AdminIcon, LogOutIcon, ProfileIcon, SettingsIcon } from "./icons";

type UserMenuLocation = "profile" | "settings" | "admin";

export function UserMenu({ current }: { current?: UserMenuLocation }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // 未登录：显示登录入口
  if (!user) {
    return (
      <a className="compose" href="/login" style={{ margin: 0 }}>Sign in</a>
    );
  }

  const handleLogout = async () => {
    await logout();
    window.location.href = "/";
  };

  return (
    <div className="user-menu" ref={menuRef}>
      <button className={`icon-btn user-menu-trigger ${current ? "profile-current" : ""}`} type="button" aria-label="Account menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ProfileIcon />
      </button>
      <div className={`user-menu-popover ${open ? "open" : ""}`} role="menu" aria-label="Account" aria-hidden={!open}>
        <a className="user-menu-profile" href="/profile" role="menuitem" tabIndex={open ? 0 : -1} onClick={() => setOpen(false)}>
          <span className="user-menu-avatar" aria-hidden="true">{initials(user.displayName)}</span>
          <span><strong>{user.displayName}</strong><small>@{user.handle}</small></span>
        </a>
        <div className="user-menu-divider" role="separator" />
        <a className="user-menu-item" href="/settings" role="menuitem" tabIndex={open ? 0 : -1} onClick={() => setOpen(false)}><SettingsIcon /><span>Settings</span></a>
        {user.role === "admin" && <a className="user-menu-item" href="/admin" role="menuitem" tabIndex={open ? 0 : -1} onClick={() => setOpen(false)}><AdminIcon /><span>Admin</span></a>}
        <button className="user-menu-item user-menu-logout" type="button" role="menuitem" tabIndex={open ? 0 : -1} onClick={handleLogout}><LogOutIcon /><span>Log out</span></button>
      </div>
    </div>
  );
}
