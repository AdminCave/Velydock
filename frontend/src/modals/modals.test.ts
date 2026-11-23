// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { AdminApp, AppCreate, SystemUser, Tenant, User } from '$lib/api/types';
import { translate } from '$lib/i18n';
import { APP_ICON_NAMES } from '$lib/appIcons';
import ConfirmDialog, { cancelConfirm } from '$lib/components/ui/ConfirmDialog.svelte';
import { ACME, MAIN, errorResponse, stubApi } from '../test/fixtures';
import { moved, visibilitySummary } from '../pages/admin/Apps.svelte';
import AddMemberModal from './AddMemberModal.svelte';
import AppModal, { ICON_MAX_BYTES, appChanges, iconFileProblem } from './AppModal.svelte';
import GroupModal from './GroupModal.svelte';
import TempPasswordModal from './TempPasswordModal.svelte';
import TenantDeleteModal from './TenantDeleteModal.svelte';
import TenantModal from './TenantModal.svelte';
import UserCreateModal from './UserCreateModal.svelte';
import UserEditModal from './UserEditModal.svelte';

const de = (key: string, vars?: Record<string, string | number | null | undefined>) =>
  translate('de', key, vars);

afterEach(() => {
  cancelConfirm();
  cleanup();
  vi.unstubAllGlobals();
});

// What a browser sends for a press and release beside a dialog: mousedown, then click.
const backdropOf = (dialog: HTMLElement) => dialog.parentElement as HTMLElement;
async function clickBeside(dialog: HTMLElement) {
  await fireEvent.mouseDown(backdropOf(dialog));
  await fireEvent.click(backdropOf(dialog));
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u-mia',
    username: 'mia',
    email: 'mia@acme.example',
    first_name: 'Mia',
    last_name: 'Mitglied',
    display_name: 'Mia Mitglied',
    active: true,
    is_system_admin: false,
    role: 'member',
    managed: true,
    home_tenant: ACME,
    groups: [{ id: 'g-office', name: 'Büro' }],
    last_login_at: null,
    created_at: '2026-01-01T00:00:00Z',
    can_edit_identity: true,
    can_edit_membership: true,
    can_assign_role: true,
    ...overrides,
  };
}

const groups = [
  { id: 'g-office', name: 'Büro', description: '', member_count: 3, app_count: 1, created_at: '' },
  { id: 'g-it', name: 'IT', description: '', member_count: 2, app_count: 1, created_at: '' },
];

describe('TempPasswordModal', () => {
  it('shows the one-time password with the test hook and the first-sign-in hint', () => {
    render(TempPasswordModal, {
      password: 'Abc-123-xyz',
      name: 'Karl Test',
      username: 'karl',
      onClose: () => {},
    });
    expect(screen.getByRole('dialog', { name: 'Einmalpasswort für Karl Test' })).toBeVisible();
    expect(screen.getByTestId('temp-password')).toHaveTextContent('Abc-123-xyz');
    expect(screen.getByText(/Bei der ersten Anmeldung/)).toBeInTheDocument();
    expect(screen.getByText('Wird nur jetzt angezeigt')).toBeInTheDocument();
  });

  it('copies the password', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(TempPasswordModal, { password: 'Abc-123', name: 'K', username: 'k', onClose: () => {} });
    await fireEvent.click(screen.getByRole('button', { name: 'Passwort kopieren' }));
    expect(writeText).toHaveBeenCalledWith('Abc-123');
  });

  it('closes through its button only: the password is shown exactly once', async () => {
    const onClose = vi.fn();
    render(TempPasswordModal, { password: 'Abc-123-xyz', name: 'K', username: 'k', onClose });
    const dialog = screen.getByRole('dialog');
    await fireEvent.keyDown(document, { key: 'Escape' });
    await clickBeside(dialog);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('temp-password')).toHaveTextContent('Abc-123-xyz');
    expect(screen.queryByRole('button', { name: 'Schließen' })).toBeNull(); // no X either
    await fireEvent.click(screen.getByRole('button', { name: de('tempPassword.done') }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves nothing in the document once closed', async () => {
    const view = render(TempPasswordModal, {
      password: 'Abc-123-xyz',
      name: 'K',
      username: 'k',
      onClose: () => {},
    });
    await view.rerender({ password: null });
    expect(screen.queryByTestId('temp-password')).toBeNull();
    expect(document.body.textContent).not.toContain('Abc-123-xyz');
  });
});

describe('UserCreateModal', () => {
  const props = {
    open: true,
    groups,
    canAssignRoles: true,
    onClose: () => {},
    onCreated: () => {},
  };

  it('validates before anything is sent', async () => {
    const { calls } = stubApi({});
    render(UserCreateModal, props);
    await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(screen.getAllByText('Dieses Feld wird gebraucht.')).toHaveLength(3);
    await fireEvent.input(screen.getByLabelText('Benutzername'), {
      target: { value: 'Karl Test' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(screen.getByText(/3–64 Zeichen: Kleinbuchstaben/, { selector: '.error' })).toBeVisible();
    // Two characters are too few (the identity provider refuses them).
    await fireEvent.input(screen.getByLabelText('Benutzername'), { target: { value: 'kt' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(screen.getByText(/3–64 Zeichen: Kleinbuchstaben/, { selector: '.error' })).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  it('closes on Escape or a click beside it while nothing has been entered', async () => {
    const onClose = vi.fn();
    render(UserCreateModal, { ...props, onClose });
    await fireEvent.keyDown(document, { key: 'Escape' });
    await clickBeside(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not lose input to a stray click or key', async () => {
    const onClose = vi.fn();
    render(ConfirmDialog);
    render(UserCreateModal, { ...props, onClose });
    const form = screen.getByRole('dialog', { name: de('users.create.title') });
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'Karl' } });
    await clickBeside(form);
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByRole('dialog', { name: 'Eingaben verwerfen?' });
    await fireEvent.click(screen.getByRole('button', { name: 'Weiter bearbeiten' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Eingaben verwerfen?' })).toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Vorname')).toHaveValue('Karl');
    // "Abbrechen" says what it does and needs no second question.
    await fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('counts a chosen group or role as input, and input taken back as none', async () => {
    const onClose = vi.fn();
    render(UserCreateModal, { ...props, onClose });
    const form = screen.getByRole('dialog');
    await fireEvent.click(screen.getByRole('checkbox', { name: 'IT' }));
    await clickBeside(form);
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('checkbox', { name: 'IT' }));
    await clickBeside(form);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says so when the e-mail with the link could not be sent, and keeps the form', async () => {
    const onCreated = vi.fn();
    stubApi({ 'POST /api/v1/admin/users': () => errorResponse(502, 'email_failed') });
    render(UserCreateModal, { ...props, onCreated });
    await fireEvent.input(screen.getByLabelText('Benutzername'), { target: { value: 'karl' } });
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'Karl' } });
    await fireEvent.input(screen.getByLabelText('Nachname'), { target: { value: 'Test' } });
    await fireEvent.input(screen.getByLabelText(de('field.email')), {
      target: { value: 'karl@acme.example' },
    });
    await fireEvent.click(screen.getByRole('checkbox', { name: /Link zum Passwort-Setzen/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Die E-Mail konnte nicht verschickt werden, deshalb wurde nichts geändert. Prüf die SMTP-Einstellungen unter System → Systemeinstellungen',
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Benutzername')).toHaveValue('karl');
  });

  it('creates the account and hands the result on', async () => {
    const onCreated = vi.fn();
    const created = {
      user: makeUser({ username: 'karl' }),
      temporary_password: 'pw',
      email_sent: false,
    };
    const { calls } = stubApi({ 'POST /api/v1/admin/users': () => created });
    render(UserCreateModal, { ...props, onCreated });
    await fireEvent.input(screen.getByLabelText('Benutzername'), { target: { value: ' Karl ' } });
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'Karl' } });
    await fireEvent.input(screen.getByLabelText('Nachname'), { target: { value: 'Test' } });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'IT' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(calls[0].body).toEqual({
      username: 'karl',
      first_name: 'Karl',
      last_name: 'Test',
      email: null,
      role: 'member',
      group_ids: ['g-it'],
      send_email: false,
    });
  });

  it('only offers "Mitglied" without the right to assign roles', () => {
    render(UserCreateModal, { ...props, canAssignRoles: false });
    const role = screen.getByLabelText('Rolle') as HTMLSelectElement;
    expect(role).toBeDisabled();
    expect([...role.options].map((o) => o.value)).toEqual(['member']);
  });

  it('offers all roles with the right to assign them', () => {
    render(UserCreateModal, props);
    const role = screen.getByLabelText('Rolle') as HTMLSelectElement;
    expect([...role.options].map((o) => o.value)).toEqual([
      'member',
      'user_manager',
      'tenant_admin',
    ]);
  });

  it('shows a taken username at the field', async () => {
    stubApi({ 'POST /api/v1/admin/users': () => errorResponse(409, 'username_taken') });
    render(UserCreateModal, props);
    await fireEvent.input(screen.getByLabelText('Benutzername'), { target: { value: 'anna' } });
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'A' } });
    await fireEvent.input(screen.getByLabelText('Nachname'), { target: { value: 'B' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(await screen.findByText('Dieser Benutzername ist bereits vergeben.')).toBeVisible();
    expect(screen.getByLabelText('Benutzername')).toHaveAttribute('aria-invalid', 'true');
  });

  it('requires an e-mail address for the e-mail invitation', async () => {
    const { calls } = stubApi({});
    render(UserCreateModal, { ...props, emailInvitations: true });
    await fireEvent.input(screen.getByLabelText('Benutzername'), { target: { value: 'karl' } });
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'A' } });
    await fireEvent.input(screen.getByLabelText('Nachname'), { target: { value: 'B' } });
    await fireEvent.click(screen.getByLabelText(/Link zum Passwort-Setzen per E-Mail senden/));
    await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(screen.getByText('Für den Versand wird eine E-Mail-Adresse gebraucht.')).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  describe('and the link by e-mail', () => {
    const option = () => screen.getByLabelText(/Link zum Passwort-Setzen per E-Mail senden/);
    const created = {
      user: makeUser({ id: 'u-karl', username: 'karl' }),
      temporary_password: 'Abc-123-xyz',
      invitation_sent: false,
    };
    async function fill() {
      await fireEvent.input(screen.getByLabelText('Benutzername'), { target: { value: 'karl' } });
      await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'Karl' } });
      await fireEvent.input(screen.getByLabelText('Nachname'), { target: { value: 'Test' } });
    }

    it('is offered when the installation can send e-mail', () => {
      render(UserCreateModal, { ...props, emailInvitations: true });
      expect(option()).toBeEnabled();
      expect(screen.getByText(/Die Person legt ihr Passwort selbst fest/)).toBeVisible();
      expect(screen.queryByText(/muss der E-Mail-Versand eingerichtet sein/)).toBeNull();
    });

    it('is not offered otherwise, with the reason and where to change that', () => {
      render(UserCreateModal, props); // not known (yet), or the question failed: not offered
      expect(option()).toBeDisabled();
      expect(option()).not.toBeChecked();
      expect(
        screen.getByText(
          /Dafür muss der E-Mail-Versand eingerichtet sein \(System → Systemeinstellungen\)/,
        ),
      ).toBeVisible();
    });

    it('is never asked of a server that cannot send it', async () => {
      const { calls } = stubApi({ 'POST /api/v1/admin/users': () => created });
      render(UserCreateModal, props);
      await fill();
      // However the tick got there (jsdom toggles a disabled checkbox on a click, browsers
      // do not): it counts for nothing while the link cannot be sent.
      await fireEvent.click(option());
      await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
      // No address is demanded for a link that will not be sent, and none is asked for.
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0].body).toMatchObject({ username: 'karl', send_email: false });
    });
  });

  describe('and names', () => {
    const RULE = /Nicht erlaubt sind die Zeichen < > & /;
    async function fill(first: string, last: string) {
      await fireEvent.input(screen.getByLabelText('Benutzername'), { target: { value: 'karl' } });
      await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: first } });
      await fireEvent.input(screen.getByLabelText('Nachname'), { target: { value: last } });
    }

    it('says at the field which characters a name must not hold, before anything is sent', async () => {
      const { calls } = stubApi({});
      render(UserCreateModal, props);
      await fill('Karl <b>', 'Test');
      await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
      expect(screen.getByText(RULE)).toBeVisible();
      expect(screen.getByLabelText('Vorname')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Nachname')).not.toHaveAttribute('aria-invalid', 'true');
      expect(calls).toHaveLength(0);
    });

    it('says the same when it is the server that refuses the name', async () => {
      // A rule this version does not know yet: the server stays the authority.
      stubApi({
        'POST /api/v1/admin/users': () =>
          errorResponse(422, 'validation', {
            fields: [{ field: 'last_name', message: 'Value error, forbidden character' }],
          }),
      });
      render(UserCreateModal, props);
      await fill('Karl', 'Test');
      await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
      await waitFor(() =>
        expect(screen.getByLabelText('Nachname')).toHaveAttribute('aria-invalid', 'true'),
      );
      expect(screen.getByText('Diese Eingabe wurde nicht angenommen.')).toBeVisible();
      expect(screen.getByLabelText('Vorname')).not.toHaveAttribute('aria-invalid', 'true');
    });
  });

  it('takes the message of a field back once that field is edited, and leaves the others', async () => {
    render(UserCreateModal, props);
    await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(screen.getAllByText('Dieses Feld wird gebraucht.')).toHaveLength(3);
    const first = screen.getByLabelText('Vorname');
    first.focus();
    await fireEvent.input(first, { target: { value: 'K' } });
    expect(screen.getAllByText('Dieses Feld wird gebraucht.')).toHaveLength(2);
    expect(first).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Nachname')).toHaveAttribute('aria-invalid', 'true');
    // Typing goes on where it was: the focus is not pulled to a field that is still wrong.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first).toHaveFocus();
    // Taken back for good, not just hidden: the same mistake made again is said again.
    await fireEvent.input(first, { target: { value: '' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(screen.getAllByText('Dieses Feld wird gebraucht.')).toHaveLength(3);
    expect(first).toHaveAttribute('aria-invalid', 'true');
  });

  it('says so when a field is full, instead of cutting what is typed or pasted without a word', async () => {
    render(UserCreateModal, props);
    expect(screen.queryByTestId('field-limit')).toBeNull();
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'x'.repeat(100) } });
    expect(screen.getByTestId('field-limit')).toHaveTextContent(
      'Mehr als 100 Zeichen sind hier nicht möglich.',
    );
    expect(screen.getByLabelText('Vorname').getAttribute('aria-describedby')).toContain(
      screen.getByTestId('field-limit').id,
    );
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'x'.repeat(99) } });
    expect(screen.queryByTestId('field-limit')).toBeNull();
  });
});

describe('UserEditModal', () => {
  const props = {
    groups,
    canEditGroups: true,
    isSelf: false,
    onClose: () => {},
    onSaved: () => {},
  };

  it('sends only what was changed', async () => {
    const onSaved = vi.fn();
    const { calls } = stubApi({ 'PATCH /api/v1/admin/users/u-mia': () => makeUser() });
    render(UserEditModal, { ...props, user: makeUser(), onSaved });
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'Maria' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0].body).toEqual({ first_name: 'Maria' });
  });

  it('sends nothing and just closes when nothing was changed', async () => {
    const onClose = vi.fn();
    const { calls } = stubApi({});
    render(UserEditModal, { ...props, user: makeUser(), onClose });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(onClose).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('does not take other blanks in a name for a change: the server stores one between words', async () => {
    const onClose = vi.fn();
    const { calls } = stubApi({});
    render(UserEditModal, { ...props, user: makeUser(), onClose });
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: '  Mia ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(onClose).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('says at the field which characters a name must not hold', async () => {
    const { calls } = stubApi({});
    render(UserEditModal, { ...props, user: makeUser() });
    await fireEvent.input(screen.getByLabelText('Nachname'), { target: { value: 'Mit{glied}' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(screen.getByText(/Nicht erlaubt sind die Zeichen < > & /)).toBeVisible();
    expect(screen.getByLabelText('Nachname')).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toHaveLength(0);
  });

  it('tells the administrator that granting administrative rights signs the person out', async () => {
    render(UserEditModal, { ...props, user: makeUser() });
    expect(screen.queryByTestId('role-signs-out')).toBeNull();
    await fireEvent.change(screen.getByLabelText('Rolle'), { target: { value: 'user_manager' } });
    expect(screen.getByTestId('role-signs-out')).toHaveTextContent(
      'Beim Speichern wird sie abgemeldet',
    );
    await fireEvent.change(screen.getByLabelText('Rolle'), { target: { value: 'member' } });
    expect(screen.queryByTestId('role-signs-out')).toBeNull();
  });

  it('says nothing of the kind when rights are taken away or stay as they are', async () => {
    render(UserEditModal, { ...props, user: makeUser({ role: 'tenant_admin' }) });
    expect(screen.queryByTestId('role-signs-out')).toBeNull();
    await fireEvent.change(screen.getByLabelText('Rolle'), { target: { value: 'user_manager' } });
    expect(screen.queryByTestId('role-signs-out')).toBeNull();
  });

  it('offers no "Speichern" where nothing can be changed', () => {
    // What a user manager gets to see of an administrator.
    const locked = makeUser({
      role: 'tenant_admin',
      groups: [],
      can_edit_identity: false,
      can_edit_membership: false,
      can_assign_role: false,
    });
    render(UserEditModal, { ...props, user: locked });
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Abbrechen' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Schließen' }).length).toBeGreaterThan(0);
  });

  it('clears the e-mail address with null', async () => {
    const { calls } = stubApi({ 'PATCH /api/v1/admin/users/u-mia': () => makeUser() });
    render(UserEditModal, { ...props, user: makeUser() });
    await fireEvent.input(screen.getByLabelText('E-Mail-Adresse'), { target: { value: '' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ email: null });
  });

  it('makes the identity read-only for a guest and says who manages the account', async () => {
    const { calls } = stubApi({ 'PATCH /api/v1/admin/users/u-mia': () => makeUser() });
    render(UserEditModal, {
      ...props,
      user: makeUser({ managed: false, home_tenant: null, can_edit_identity: false }),
    });
    expect(screen.getByTestId('identity-locked')).toHaveTextContent(
      'Dieses Konto wird von einer anderen Organisation verwaltet.',
    );
    for (const label of ['Vorname', 'Nachname', 'E-Mail-Adresse']) {
      expect(screen.getByLabelText(label)).toHaveAttribute('readonly');
    }
    // What the person may do here can still be changed.
    await fireEvent.change(screen.getByLabelText('Rolle'), { target: { value: 'user_manager' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ role: 'user_manager' });
  });

  it('explains an account that outranks the administrator', () => {
    render(UserEditModal, {
      ...props,
      user: makeUser({
        can_edit_identity: false,
        can_assign_role: false,
        can_edit_membership: false,
      }),
    });
    expect(screen.getByTestId('identity-locked')).toHaveTextContent('mehr Rechte als du');
    expect(screen.getByLabelText('Rolle')).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'IT' })).toBeDisabled();
  });

  it('does not let anyone change their own role', () => {
    render(UserEditModal, { ...props, isSelf: true, user: makeUser({ can_assign_role: false }) });
    expect(screen.getByLabelText('Rolle')).toBeDisabled();
    expect(screen.getByText('Deine eigene Rolle kannst du nicht ändern.')).toBeVisible();
  });

  it('closes on a click beside it only while nothing was changed', async () => {
    const onClose = vi.fn();
    render(UserEditModal, { ...props, user: makeUser(), onClose });
    const dialog = screen.getByRole('dialog');
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'Maria' } });
    await clickBeside(dialog);
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.input(screen.getByLabelText('Vorname'), { target: { value: 'Mia' } });
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not take the same groups picked in another order for a change', async () => {
    const onClose = vi.fn();
    const user = makeUser({
      groups: [
        { id: 'g-office', name: 'Büro' },
        { id: 'g-it', name: 'IT' },
      ],
    });
    render(UserEditModal, { ...props, user, onClose });
    const office = screen.getByRole('checkbox', { name: 'Büro' });
    // Off and on again: the same two groups, with "Büro" now last in the list.
    await fireEvent.click(office);
    await clickBeside(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.click(office);
    expect(office).toBeChecked();
    await clickBeside(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('GroupModal', () => {
  const group = groups[0];
  const clara = makeUser({
    id: 'u-clara',
    username: 'clara',
    first_name: 'Clara',
    last_name: 'Chefin',
    display_name: 'Clara Chefin',
    role: 'tenant_admin',
    // What the API reports to a user manager about an administrator.
    can_edit_identity: false,
    can_edit_membership: false,
    can_assign_role: false,
  });
  const mia = makeUser();
  const ben = makeUser({
    id: 'u-ben',
    username: 'ben',
    first_name: 'Ben',
    last_name: 'Büro',
    display_name: 'Ben Büro',
  });
  const props = { open: true, group, canReadUsers: true, onClose: () => {}, onSaved: () => {} };
  const page = (items: User[]) => ({ items, total: items.length, page: 1, page_size: 200 });

  it('shows members who outrank the administrator but does not let them be added or removed', async () => {
    const onSaved = vi.fn();
    const { calls } = stubApi({
      'GET /api/v1/admin/users': () => page([clara, mia, ben]),
      'GET /api/v1/admin/groups/g-office': () => ({ ...group, member_ids: ['u-clara', 'u-mia'] }),
      'PATCH /api/v1/admin/groups/g-office': () => ({ ...group, member_ids: [] }),
    });
    render(GroupModal, { ...props, onSaved });
    const locked = await screen.findByRole('checkbox', { name: /Clara Chefin/ });
    expect(locked).toBeChecked(); // a member, and shown as one
    expect(locked).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Clara Chefin entfernen' })).toBeNull();
    expect(screen.getByText(/Ausgegraute Konten haben mehr Rechte als du/)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Mia Mitglied/ })).toBeEnabled();

    // Other members can still be changed; the locked one is sent on unchanged.
    await fireEvent.click(screen.getByRole('checkbox', { name: /Ben Büro/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toMatchObject({ member_ids: ['u-clara', 'u-mia', 'u-ben'] });
  });

  it('sends only what was changed here, so a rename made elsewhere meanwhile stays', async () => {
    const onSaved = vi.fn();
    const { calls } = stubApi({
      'GET /api/v1/admin/users': () => page([mia, ben]),
      'GET /api/v1/admin/groups/g-office': () => ({ ...group, member_ids: ['u-mia'] }),
      // In the meantime somebody else has renamed the group.
      'PATCH /api/v1/admin/groups/g-office': () => ({
        ...group,
        name: 'Büro Nord',
        member_ids: ['u-mia'],
      }),
    });
    render(GroupModal, { ...props, onSaved });
    await screen.findByRole('checkbox', { name: /Mia Mitglied/ });
    await fireEvent.input(screen.getByLabelText('Beschreibung'), {
      target: { value: 'Alle im Büro' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ description: 'Alle im Büro' }); // and not the old name
  });

  it('sends each of name, description and members only when it was changed', async () => {
    const { calls } = stubApi({
      'GET /api/v1/admin/users': () => page([mia, ben]),
      'GET /api/v1/admin/groups/g-office': () => ({ ...group, member_ids: ['u-mia'] }),
      'PATCH /api/v1/admin/groups/g-office': () => ({ ...group, member_ids: ['u-mia'] }),
    });
    render(GroupModal, props);
    await screen.findByRole('checkbox', { name: /Mia Mitglied/ });
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Büro  Nord ' } });
    await fireEvent.click(screen.getByRole('checkbox', { name: /Ben Büro/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      name: 'Büro Nord',
      member_ids: ['u-mia', 'u-ben'],
    });
  });

  it('sends nothing and announces nothing when nothing was changed', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const { calls } = stubApi({
      'GET /api/v1/admin/users': () => page([mia, ben]),
      'GET /api/v1/admin/groups/g-office': () => ({ ...group, member_ids: ['u-mia'] }),
    });
    render(GroupModal, { ...props, onSaved, onClose });
    await screen.findByRole('checkbox', { name: /Mia Mitglied/ });
    // Other blanks in the name are no change either: the server stores one between words.
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: ' Büro ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSaved).not.toHaveBeenCalled(); // no "gespeichert" for a save that saved nothing
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('takes "Dieses Feld wird gebraucht." back as soon as a name is typed', async () => {
    stubApi({ 'GET /api/v1/admin/users': () => page([mia]) });
    render(GroupModal, { ...props, group: null });
    await screen.findByRole('checkbox', { name: /Mia Mitglied/ });
    await fireEvent.click(screen.getByRole('button', { name: 'Gruppe anlegen' }));
    expect(screen.getByText('Dieses Feld wird gebraucht.')).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'V' } });
    expect(screen.queryByText('Dieses Feld wird gebraucht.')).toBeNull();
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid', 'true');
    // Taken back for good, not just hidden: the same mistake made again is said again.
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: '' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Gruppe anlegen' }));
    expect(screen.getByText('Dieses Feld wird gebraucht.')).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('cannot add somebody who outranks the administrator to a new group', async () => {
    stubApi({ 'GET /api/v1/admin/users': () => page([clara, mia]) });
    render(GroupModal, { ...props, group: null });
    const locked = await screen.findByRole('checkbox', { name: /Clara Chefin/ });
    expect(locked).not.toBeChecked();
    expect(locked).toBeDisabled();
  });

  it('counts changes from the members the server reports, which arrive after it opened', async () => {
    const onClose = vi.fn();
    stubApi({
      'GET /api/v1/admin/users': () => page([clara, mia, ben]),
      'GET /api/v1/admin/groups/g-office': () => ({ ...group, member_ids: ['u-clara', 'u-mia'] }),
    });
    render(GroupModal, { ...props, onClose });
    const dialog = screen.getByRole('dialog');
    const member = await screen.findByRole('checkbox', { name: /Mia Mitglied/ });
    expect(member).toBeChecked();
    // Loaded, nothing touched: the members that arrived are the starting point, no input.
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    // A member added: a stray click must not throw that away …
    await fireEvent.click(screen.getByRole('checkbox', { name: /Ben Büro/ }));
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    // … taken back: nothing to lose.
    await fireEvent.click(screen.getByRole('checkbox', { name: /Ben Büro/ }));
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
    // A member removed and added again: the same members, in another order.
    await fireEvent.click(member);
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
    await fireEvent.click(member);
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(3);
    // And the name counts as well.
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Büro Nord' } });
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('asks before Escape discards changed members', async () => {
    const onClose = vi.fn();
    stubApi({
      'GET /api/v1/admin/users': () => page([mia, ben]),
      'GET /api/v1/admin/groups/g-office': () => ({ ...group, member_ids: ['u-mia'] }),
    });
    render(ConfirmDialog);
    render(GroupModal, { ...props, onClose });
    await fireEvent.click(await screen.findByRole('checkbox', { name: /Ben Büro/ }));
    await fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByRole('dialog', { name: 'Eingaben verwerfen?' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says nothing about locked accounts when every member may be changed', async () => {
    stubApi({
      'GET /api/v1/admin/users': () => page([mia, ben]),
      'GET /api/v1/admin/groups/g-office': () => ({ ...group, member_ids: ['u-mia'] }),
    });
    render(GroupModal, props);
    expect(await screen.findByRole('checkbox', { name: /Ben Büro/ })).toBeEnabled();
    expect(screen.queryByText(/Ausgegraute Konten/)).toBeNull();
  });
});

describe('TenantModal', () => {
  const props = { open: true, tenant: null, onClose: () => {}, onSaved: () => {} };

  it('suggests the short name from the name until it is edited by hand', async () => {
    render(TenantModal, props);
    const name = screen.getByLabelText('Name');
    const slug = screen.getByLabelText('Kurzname') as HTMLInputElement;
    await fireEvent.input(name, { target: { value: 'Müller & Söhne' } });
    expect(slug.value).toBe('mueller-soehne');
    await fireEvent.input(slug, { target: { value: 'ms' } });
    await fireEvent.input(name, { target: { value: 'Müller & Söhne GmbH' } });
    expect(slug.value).toBe('ms');
  });

  it('rejects a reserved or malformed short name before sending', async () => {
    const { calls } = stubApi({});
    render(TenantModal, props);
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Verwaltung' } });
    await fireEvent.input(screen.getByLabelText('Kurzname'), { target: { value: 'admin' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Organisation anlegen' }));
    expect(screen.getByText(/Dieser Kurzname ist reserviert/)).toBeVisible();
    await fireEvent.input(screen.getByLabelText('Kurzname'), { target: { value: 'Ver waltung' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Organisation anlegen' }));
    expect(screen.getByText(/Erlaubt sind 2–40 Zeichen/)).toBeVisible();
    expect(calls).toHaveLength(0);
  });
});

describe('TenantModal with input in it', () => {
  const stored: Tenant = {
    ...ACME,
    active: true,
    protected: false,
    proxy_path_allowed: true,
    default_nav_position: null,
    nav_position_locked: false,
    member_count: 36,
    app_count: 5,
    created_at: '',
  };

  it('does not lose a typed name to a stray click, and closes while it is empty', async () => {
    const onClose = vi.fn();
    render(TenantModal, { open: true, tenant: null, onClose, onSaved: () => {} });
    const dialog = screen.getByRole('dialog');
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Stadtwerke' } });
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Emptied again (the suggested short name goes with it): nothing to lose.
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: '' } });
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renames nothing, and says nothing, when the name is the one it has', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const { calls } = stubApi({});
    render(TenantModal, { open: true, tenant: stored, onClose, onSaved });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // The same name but for blanks: the server would store the same again.
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: ' Acme  GmbH ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSaved).not.toHaveBeenCalled(); // no "heißt jetzt …", no entry in the audit log
    expect(calls).toHaveLength(0);
  });

  it('sends a new name as the server stores it', async () => {
    const onSaved = vi.fn();
    const { calls } = stubApi({
      'PATCH /api/v1/system/tenants/t-acme': () => ({ ...stored, name: 'Acme AG' }),
    });
    render(TenantModal, { open: true, tenant: stored, onClose: () => {}, onSaved });
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: ' Acme   AG' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0].body).toEqual({ name: 'Acme AG' });
  });

  it('compares with the stored name when an organization is renamed', async () => {
    const onClose = vi.fn();
    render(ConfirmDialog);
    render(TenantModal, { open: true, tenant: stored, onClose, onSaved: () => {} });
    const dialog = screen.getByRole('dialog', { name: /Acme GmbH/ });
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(1); // opened and left alone
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Acme AG' } });
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByRole('dialog', { name: 'Eingaben verwerfen?' });
    await fireEvent.click(screen.getByRole('button', { name: 'Weiter bearbeiten' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Eingaben verwerfen?' })).toBeNull(),
    );
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Acme GmbH' } });
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('AddMemberModal', () => {
  const tenant = (ref: { id: string; slug: string; name: string }): Tenant => ({
    ...ref,
    active: true,
    protected: false,
    proxy_path_allowed: true,
    default_nav_position: null,
    nav_position_locked: false,
    member_count: 3,
    app_count: 1,
    created_at: '',
  });
  const user: SystemUser = {
    id: 'u-mia',
    username: 'mia',
    email: 'mia@acme.example',
    display_name: 'Mia Mitglied',
    active: true,
    is_system_admin: false,
    home_tenant: ACME,
    memberships: [{ tenant: ACME, role: 'member' }],
    last_login_at: null,
  };
  const props = { user, tenants: [tenant(ACME), tenant(MAIN)], onAdded: () => {} };

  it('closes on a stray click or key only while nothing was chosen', async () => {
    const onClose = vi.fn();
    render(ConfirmDialog);
    render(AddMemberModal, { ...props, onClose });
    const dialog = screen.getByRole('dialog', { name: /Mia Mitglied/ });
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    await fireEvent.change(screen.getByLabelText(/^Organisation/), {
      target: { value: MAIN.id },
    });
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByRole('dialog', { name: 'Eingaben verwerfen?' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says that a role with administrative rights signs the person out', async () => {
    render(AddMemberModal, { ...props, onClose: () => {} });
    expect(screen.queryByTestId('role-signs-out')).toBeNull();
    await fireEvent.change(screen.getByLabelText('Rolle'), { target: { value: 'tenant_admin' } });
    expect(screen.getByTestId('role-signs-out')).toHaveTextContent(
      'Beim Speichern wird sie abgemeldet',
    );
    await fireEvent.change(screen.getByLabelText('Rolle'), { target: { value: 'member' } });
    expect(screen.queryByTestId('role-signs-out')).toBeNull();
  });

  it('counts another role as a choice too', async () => {
    const onClose = vi.fn();
    render(AddMemberModal, { ...props, onClose });
    await fireEvent.change(screen.getByLabelText('Rolle'), { target: { value: 'user_manager' } });
    await clickBeside(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('TenantDeleteModal', () => {
  const tenant: Tenant = {
    ...ACME,
    active: true,
    protected: false,
    proxy_path_allowed: true,
    default_nav_position: null,
    nav_position_locked: false,
    member_count: 36,
    app_count: 5,
    created_at: '',
  };

  it('only deletes once the short name has been typed out', async () => {
    const onDeleted = vi.fn();
    const { calls } = stubApi({
      'POST /api/v1/system/tenants/t-acme/delete': () => new Response(null, { status: 204 }),
    });
    render(TenantDeleteModal, { tenant, onClose: () => {}, onDeleted });
    const button = screen.getByRole('button', { name: 'Endgültig löschen' });
    expect(button).toBeDisabled();
    expect(screen.getByText(/alle Konten, die ihr gehören/)).toBeVisible();
    const input = screen.getByLabelText('Gib zur Bestätigung den Kurznamen „acme“ ein');
    await fireEvent.input(input, { target: { value: 'acm' } });
    expect(button).toBeDisabled();
    await fireEvent.input(input, { target: { value: 'acme' } });
    expect(button).toBeEnabled();
    await fireEvent.click(button);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(tenant));
    expect(calls[0].body).toEqual({ confirm_slug: 'acme' });
  });
});

describe('AppModal', () => {
  const props = {
    open: true,
    app: null,
    groups: [],
    canReadUsers: false,
    systemAdmin: false,
    onClose: () => {},
    onSaved: () => {},
  };
  const icons = () => screen.getAllByRole('radio').filter((el) => el.tagName === 'BUTTON');

  it('makes the icon grid a single Tab stop: the chosen icon', async () => {
    render(AppModal, props);
    const all = icons();
    expect(all).toHaveLength(APP_ICON_NAMES.length);
    expect(all.filter((icon) => icon.tabIndex === 0)).toHaveLength(1);
    const chosen = all.find((icon) => icon.getAttribute('aria-checked') === 'true');
    expect(chosen).toBeDefined();
    expect(chosen?.tabIndex).toBe(0);
    // Choosing another icon moves the Tab stop with it.
    await fireEvent.click(all[5]);
    expect(all[5]).toHaveAttribute('aria-checked', 'true');
    all[5].focus();
    await waitFor(() => expect(all.filter((icon) => icon.tabIndex === 0)).toEqual([all[5]]));
  });

  it('moves inside the icon grid with the arrow keys, Home and End, without choosing', async () => {
    render(AppModal, props);
    const all = icons();
    const last = all.length - 1;
    all[0].focus();
    await fireEvent.keyDown(all[0], { key: 'ArrowRight' });
    expect(all[1]).toHaveFocus();
    await fireEvent.keyDown(all[1], { key: 'ArrowLeft' });
    await fireEvent.keyDown(all[0], { key: 'ArrowLeft' });
    expect(all[last]).toHaveFocus(); // wraps around
    await fireEvent.keyDown(all[last], { key: 'Home' });
    expect(all[0]).toHaveFocus();
    await fireEvent.keyDown(all[0], { key: 'End' });
    expect(all[last]).toHaveFocus();
    // The Tab stop follows the focus, so Tab out and back in returns here.
    await waitFor(() => expect(all.filter((icon) => icon.tabIndex === 0)).toEqual([all[last]]));
    // Moving does not choose: the first icon is still the chosen one.
    expect(all[0]).toHaveAttribute('aria-checked', 'true');
    expect(all[last]).toHaveAttribute('aria-checked', 'false');
    // Keys with a modifier are the browser's.
    await fireEvent.keyDown(all[last], { key: 'ArrowLeft', altKey: true });
    expect(all[last]).toHaveFocus();
  });

  it('names the icons in the language of the page, not by their identifiers', () => {
    render(AppModal, props);
    const all = icons();
    expect(screen.getByRole('radio', { name: 'Rettungsring' })).toHaveAttribute(
      'data-icon',
      'life-buoy',
    );
    expect(screen.getByRole('radio', { name: 'Fenster' })).toHaveAttribute(
      'data-icon',
      'app-window',
    );
    for (const icon of all) {
      const name = icon.getAttribute('aria-label') ?? '';
      expect(name, icon.dataset.icon).toBe(de(`icon.${icon.dataset.icon}`));
      expect(name, icon.dataset.icon).not.toBe(icon.dataset.icon);
    }
    // Every name is there once: two icons with one name could not be told apart.
    expect(new Set(all.map((icon) => icon.getAttribute('aria-label'))).size).toBe(all.length);
  });

  it('says which addresses the chosen type takes', async () => {
    render(AppModal, props);
    expect(screen.getByText(/beginnend mit https:\/\/$/)).toBeVisible();
    await fireEvent.click(screen.getByRole('radio', { name: de('app.type.external') }));
    // A new tab may be opened for an http:// address as well.
    expect(screen.getByText(/beginnend mit https:\/\/ oder http:\/\/$/)).toBeVisible();
  });

  describe('after checking whether the site can be embedded', () => {
    async function check(detail: string, status = 'blocked') {
      stubApi({ 'POST /api/v1/admin/apps/check-embed': () => ({ status, detail }) });
      render(AppModal, props);
      await fireEvent.input(screen.getByLabelText('Adresse (URL)'), {
        target: { value: 'https://wiki.example/' },
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Einbettbarkeit prüfen' }));
      return screen.findByTestId('embed-check');
    }

    it('says what was found in the language of the page', async () => {
      const result = await check('xfo_deny');
      expect(result).toHaveTextContent(
        'Die Seite verbietet jedes Einbetten (X-Frame-Options: DENY).',
      );
      expect(result).not.toHaveTextContent('xfo_deny');
    });

    it('keeps the value that belongs to what was found', async () => {
      const result = await check('redirect_other_host: login.example.org', 'unknown');
      expect(result).toHaveTextContent(
        'Die Seite leitet auf eine andere Adresse weiter (login.example.org); die wurde nicht geprüft.',
      );
    });

    it('shows a finding it does not know as the server sent it', async () => {
      expect(await check('quantum_tunnel: 42', 'unknown')).toHaveTextContent('quantum_tunnel: 42');
    });

    it('moves the focus to the type when the button that changed it goes away', async () => {
      await check('xfo_deny');
      const button = screen.getByRole('button', { name: 'Auf „Neuer Tab“ umstellen' });
      button.focus();
      await fireEvent.click(button);
      const external = screen.getByRole('radio', { name: de('app.type.external') });
      expect(external).toBeChecked();
      expect(screen.queryByTestId('embed-check')).toBeNull();
      await waitFor(() => expect(external).toHaveFocus());
    });
  });

  it('does not bring a message back that was taken back, when another field gets one', async () => {
    stubApi({
      'POST /api/v1/admin/apps/check-embed': () => errorResponse(503, 'unavailable'),
    });
    render(AppModal, props);
    await fireEvent.click(screen.getByRole('button', { name: de('apps.create.submit') }));
    const name = screen.getByLabelText('Name');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    await fireEvent.input(name, { target: { value: 'Wiki' } });
    expect(name).not.toHaveAttribute('aria-invalid', 'true');
    // The check of the address fails: a message for the address, on top of what is there.
    const address = screen.getByLabelText('Adresse (URL)');
    await fireEvent.input(address, { target: { value: 'https://wiki.example/' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Einbettbarkeit prüfen' }));
    await waitFor(() => expect(address).toHaveAttribute('aria-invalid', 'true'));
    // The form itself has forgotten the message about the name, not only the field.
    expect(name).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('says at the network switch of a custom app that links do not open without it', async () => {
    render(AppModal, props);
    await fireEvent.click(screen.getByRole('radio', { name: de('app.type.custom') }));
    const option = screen.getByRole('switch', { name: 'Netzwerkzugriff erlauben' });
    expect(option.closest('.option')).toHaveTextContent('auch Links in der App öffnen dann nicht');
    expect(translate('en', 'apps.custom.network.text')).toContain(
      'links in the app do not open either',
    );
  });

  it('does not lose typed code to a stray click beside the dialog', async () => {
    const onClose = vi.fn();
    render(AppModal, { ...props, onClose });
    const dialog = screen.getByRole('dialog');
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(1); // untouched: closes
    await fireEvent.click(screen.getByRole('radio', { name: de('app.type.custom') }));
    await fireEvent.input(screen.getByLabelText('HTML'), { target: { value: '<h1>Hallo</h1>' } });
    await clickBeside(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('app form helpers', () => {
  const stored: AdminApp = {
    id: 'a1',
    name: 'Wiki',
    description: 'Wissen',
    type: 'embedded',
    url: 'https://wiki.example/',
    enabled: true,
    sort_order: 10,
    visible_to_all: false,
    group_ids: ['g1', 'g2'],
    user_ids: [],
    icon_name: 'book-open',
    icon_url: null,
    frame_permissions: ['camera'],
    embed_status: 'ok',
    embed_detail: '',
    embed_checked_at: null,
    custom_html: '',
    custom_css: '',
    custom_js: '',
    custom_allow_network: false,
    created_at: '',
    updated_at: '',
  };
  const form = (overrides: Partial<AppCreate> = {}): AppCreate => ({
    name: 'Wiki',
    description: 'Wissen',
    type: 'embedded',
    url: 'https://wiki.example/',
    enabled: true,
    visible_to_all: false,
    group_ids: ['g2', 'g1'],
    user_ids: [],
    frame_permissions: ['camera'],
    custom_html: '',
    custom_css: '',
    custom_js: '',
    custom_allow_network: false,
    ...overrides,
  });

  it('appChanges: nothing changed, nothing sent (order of ids does not matter)', () => {
    expect(appChanges(stored, form())).toEqual({});
  });

  it('appChanges: only the differing fields', () => {
    expect(appChanges(stored, form({ name: 'Wiki 2', enabled: false }))).toEqual({
      name: 'Wiki 2',
      enabled: false,
    });
    expect(appChanges(stored, form({ group_ids: ['g1'] }))).toEqual({ group_ids: ['g1'] });
    expect(
      appChanges(
        stored,
        form({ type: 'custom', url: null, frame_permissions: [], custom_html: '<p>' }),
      ),
    ).toEqual({ type: 'custom', url: null, frame_permissions: [], custom_html: '<p>' });
  });

  it('appChanges: a new icon always counts', () => {
    expect(appChanges(stored, form({ icon: { name: 'cloud' } }))).toEqual({
      icon: { name: 'cloud' },
    });
  });

  it('iconFileProblem: type and size limits of the API', () => {
    expect(iconFileProblem({ type: 'image/png', size: 1000 })).toBeNull();
    expect(iconFileProblem({ type: 'image/svg+xml', size: ICON_MAX_BYTES })).toBeNull();
    expect(iconFileProblem({ type: 'image/png', size: ICON_MAX_BYTES + 1 })).toBe('icon_too_large');
    expect(iconFileProblem({ type: 'image/png', size: 0 })).toBe('icon_too_large');
    expect(iconFileProblem({ type: 'text/plain', size: 10 })).toBe('icon_invalid');
    expect(iconFileProblem({ type: 'image/bmp', size: 10 })).toBe('icon_invalid');
    expect(ICON_MAX_BYTES).toBe(256 * 1024);
  });

  it('visibilitySummary: who sees the app, in a few words', () => {
    const app = { visible_to_all: false, group_ids: [] as string[], user_ids: [] as string[] };
    expect(visibilitySummary({ ...app, visible_to_all: true, group_ids: ['g'] }, de)).toBe(
      'Alle Mitglieder',
    );
    expect(visibilitySummary(app, de)).toBe('Niemand');
    expect(visibilitySummary({ ...app, group_ids: ['a'] }, de)).toBe('1 Gruppe');
    expect(visibilitySummary({ ...app, group_ids: ['a', 'b'], user_ids: ['u'] }, de)).toBe(
      '2 Gruppen, 1 Person',
    );
    expect(visibilitySummary({ ...app, user_ids: ['u', 'v', 'w'] }, de)).toBe('3 Personen');
  });

  it('moved: one place up or down, never out of the list', () => {
    expect(moved(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b', 'c'], 0, -1)).toBeNull();
    expect(moved(['a', 'b', 'c'], 2, 1)).toBeNull();
    expect(moved(['a'], 5, -1)).toBeNull();
  });
});
