"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, Copy, Info, Mail } from "lucide-react";

import { Badge, Button, Card, Input, Skeleton, Spinner } from "@/components/ui";
import {
  createInvite,
  getStaff,
  listInvites,
  revokeInvite,
  setUserActive,
  setUserRole,
  type CreateInvitePayload,
  type Invite,
  type StaffProfile,
} from "@/lib/data/admin";
import { getSessionUser, type AuthUser } from "@/lib/data/auth";
import type { AssignableRole } from "@/lib/roles";
import { cn } from "@/lib/utils/cn";

const ASSIGNABLE: AssignableRole[] = [
  "admin",
  "doctor",
  "nurse",
  "billing",
  "patient",
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function UsersPage() {
  const t = useTranslations("users");
  const tRoles = useTranslations("roles");
  const locale = useLocale();

  const [session, setSession] = useState<AuthUser | null>(null);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sessionNote, setSessionNote] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AssignableRole>("nurse");
  const [inviteError, setInviteError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [created, setCreated] = useState<CreateInvitePayload | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([getSessionUser(), getStaff(), listInvites()]).then(
      ([user, list, inv]) => {
        if (!active) return;
        setSession(user.data);
        if (list.error) setLoadFailed(true);
        else setStaff(list.data ?? []);
        setInvites(inv.data ?? []);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function reload() {
    const [list, inv] = await Promise.all([getStaff(), listInvites()]);
    if (!list.error) setStaff(list.data ?? []);
    setInvites(inv.data ?? []);
  }

  function messageFor(code: string) {
    switch (code) {
      case "CANNOT_DEACTIVATE_SELF":
        return t("cannotDeactivateSelf");
      case "CANNOT_DEACTIVATE_LAST_ADMIN":
        return t("cannotDeactivateLastAdmin");
      case "CANNOT_DEMOTE_LAST_ADMIN":
        return t("cannotDemoteLastAdmin");
      case "USER_NOT_IN_TENANT":
        return t("userNotInTenant");
      case "NOT_ADMIN":
        return t("notAdmin");
      case "ALREADY_MEMBER":
        return t("alreadyMember");
      case "INVITE_ALREADY_EXISTS":
        return t("inviteAlreadyExists");
      case "NETWORK_ERROR":
        return t("networkError");
      case "PERMISSION_DENIED":
        return t("permissionError");
      default:
        return t("genericError");
    }
  }

  async function onToggleActive(person: StaffProfile) {
    setActionError(null);
    setSessionNote(null);
    setBusyId(person.id);
    const { data, error } = await setUserActive(person.id, !person.is_active);
    setBusyId(null);
    if (error) {
      setActionError(messageFor(error.code));
      return;
    }
    // Only present on deactivation, and worth surfacing: access is revoked at the
    // data layer but the user's existing session stays valid until it expires.
    if (data?.session_note) setSessionNote(data.session_note);
    await reload();
  }

  async function onChangeRole(person: StaffProfile, role: AssignableRole) {
    setActionError(null);
    setBusyId(person.id);
    const { error } = await setUserRole(person.id, role);
    setBusyId(null);
    if (error) {
      setActionError(messageFor(error.code));
      return;
    }
    await reload();
  }

  async function onInvite() {
    setInviteError(undefined);
    setCreated(null);
    setCopied(false);
    const email = inviteEmail.trim();
    if (!email || !EMAIL_RE.test(email)) {
      setInviteError(t("invalidEmail"));
      return;
    }
    setSending(true);
    const { data, error } = await createInvite(email, inviteRole);
    setSending(false);
    if (error) {
      setInviteError(messageFor(error.code));
      return;
    }
    setCreated(data);
    setInviteEmail("");
    await reload();
  }

  async function onRevoke(inviteId: string) {
    setBusyId(inviteId);
    await revokeInvite(inviteId);
    setBusyId(null);
    await reload();
  }

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  function inviteLink(token: string) {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/onboarding?token=${token}`;
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      {actionError ? (
        <p
          role="alert"
          className="mt-4 flex items-center gap-1.5 text-sm text-text-secondary"
        >
          <AlertCircle
            className="h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          {actionError}
        </p>
      ) : null}

      {sessionNote ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning bg-warning/10 p-3">
          <Info
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          <div className="text-sm">
            <p className="font-medium text-text-primary">
              {t("sessionNoteTitle")}
            </p>
            <p className="text-text-secondary">{sessionNote}</p>
          </div>
        </div>
      ) : null}

      <section className="mt-6">
        <h2 className="text-lg font-medium">{t("staffTitle")}</h2>
        <p className="mt-1 text-sm text-text-secondary">{t("noDeleteNote")}</p>

        <div className="mt-3 flex flex-col gap-2">
          {loading ? (
            [0, 1, 2].map((i) => (
              <Card key={i}>
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-2 h-3 w-24" />
              </Card>
            ))
          ) : loadFailed ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
              <p className="text-sm text-text-secondary">{t("loadError")}</p>
              <Button variant="secondary" size="sm" onClick={() => void reload()}>
                {t("retry")}
              </Button>
            </div>
          ) : (
            staff.map((person) => {
              const busy = busyId === person.id;
              const isSelf = person.id === session?.userId;
              return (
                <Card
                  key={person.id}
                  className={person.is_active ? "" : "bg-surface-muted"}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-text-primary">
                        {person.full_name ?? "—"}
                        {isSelf ? (
                          <span className="ml-2 text-sm font-normal text-text-secondary">
                            ({t("you")})
                          </span>
                        ) : null}
                      </p>
                      {!person.is_active && person.deactivated_at ? (
                        <p className="text-sm text-text-secondary">
                          {t("deactivatedOn", {
                            date: dateFormat.format(
                              new Date(person.deactivated_at),
                            ),
                          })}
                        </p>
                      ) : null}
                    </div>
                    <Badge tone={person.is_active ? "success" : "neutral"}>
                      {person.is_active ? t("active") : t("inactive")}
                    </Badge>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <span className="text-text-secondary">{t("role")}</span>
                      <select
                        value={person.role}
                        disabled={busy}
                        onChange={(event) =>
                          void onChangeRole(
                            person,
                            event.target.value as AssignableRole,
                          )
                        }
                        className={cn(
                          "h-9 rounded-md border border-border bg-surface px-2 text-sm text-text-primary",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                          "disabled:opacity-50",
                        )}
                      >
                        {ASSIGNABLE.map((role) => (
                          <option key={role} value={role}>
                            {tRoles(role)}
                          </option>
                        ))}
                      </select>
                    </label>

                    {/* No delete — access removal is deactivation. */}
                    <div className="ml-auto">
                      <Button
                        size="sm"
                        variant={person.is_active ? "secondary" : "primary"}
                        disabled={busy}
                        onClick={() => void onToggleActive(person)}
                      >
                        {busy ? (
                          <>
                            <Spinner />
                            {t("working")}
                          </>
                        ) : person.is_active ? (
                          t("deactivate")
                        ) : (
                          t("reactivate")
                        )}
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-medium">{t("invitesTitle")}</h2>

        <Card className="mt-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <Input
              label={t("inviteEmail")}
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              error={inviteError}
            />
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="invite-role"
                className="text-sm font-medium text-text-primary"
              >
                {t("inviteRole")}
              </label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as AssignableRole)
                }
                className="h-11 rounded-md border border-border bg-surface px-3 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {ASSIGNABLE.map((role) => (
                  <option key={role} value={role}>
                    {tRoles(role)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-3">
            <Button size="sm" disabled={sending} onClick={() => void onInvite()}>
              {sending ? (
                <>
                  <Spinner />
                  {t("sending")}
                </>
              ) : (
                <>
                  <Mail className="h-4 w-4" aria-hidden="true" />
                  {t("sendInvite")}
                </>
              )}
            </Button>
          </div>

          {created ? (
            <div className="mt-4 rounded-md border border-border bg-accent-subtle p-3">
              <p className="font-medium text-text-primary">
                {created.refreshed
                  ? t("inviteResentTitle")
                  : t("inviteCreatedTitle")}
              </p>
              {/* A refreshed invite rotated the token — the old link is dead. */}
              {created.refreshed ? (
                <p className="mt-0.5 text-sm text-text-secondary">
                  {t("inviteResentBody")}
                </p>
              ) : null}
              <p className="mt-2 text-sm text-text-secondary">
                {t("inviteLinkNote")}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 text-xs text-text-primary">
                  {inviteLink(created.token)}
                </code>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(inviteLink(created.token))
                      .then(() => setCopied(true));
                  }}
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  {copied ? t("copied") : t("copyLink")}
                </Button>
              </div>
            </div>
          ) : null}
        </Card>

        {invites.length === 0 ? (
          <p className="mt-3 text-sm text-text-secondary">{t("noInvites")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {invites.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-text-primary">
                    {invite.email}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {tRoles(invite.role)} ·{" "}
                    {t("expires", {
                      date: dateFormat.format(new Date(invite.expires_at)),
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busyId === invite.id}
                  onClick={() => void onRevoke(invite.id)}
                  className="text-sm text-text-secondary underline-offset-4 hover:underline disabled:opacity-50"
                >
                  {t("revoke")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
