import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

const capability = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const translation = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));
vi.mock('@/shared/api', () => ({ api: {
  hub: { backends: async () => ({ ok: true, json: async () => ({ backends: [{ id: 'ubuntu', name: 'Ubuntu', online: true }] }) }) },
  projectIsolationCapabilities: capability,
} }));
vi.mock('@/modules/project-creation-wizard/utils/workspaceApi', () => ({ createProjectRequest: create }));
vi.mock('@/modules/project-creation-wizard/WorkspacePathField', () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <input aria-label="path" value={value} onChange={(event) => onChange(event.target.value)} /> }));
const { default: ProjectCreationWizard } = await import('@/modules/project-creation-wizard/ProjectCreationWizard');

beforeEach(() => { create.mockReset(); capability.mockReset(); capability.mockResolvedValue({ ok: true, json: async () => ({ available: true }) }); });

async function pathStep() {
  render(<ProjectCreationWizard onClose={() => {}} />);
  await waitFor(() => assert.equal((screen.getByRole('button', { name: 'projectWizard.buttons.next' }) as HTMLButtonElement).disabled, false));
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  await screen.findByRole('checkbox');
}

test('creation sends the selected strict mode to the selected backend and keeps failed preparation visible', async () => {
  create.mockRejectedValue(new Error('Docker preparation failed'));
  await pathStep();
  await waitFor(() => assert.equal((screen.getByRole('checkbox') as HTMLInputElement).disabled, false));
  fireEvent.change(screen.getByRole('textbox', { name: 'path' }), { target: { value: '/workspace/project' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await screen.findByText('Docker preparation failed');
  assert.deepEqual(create.mock.calls[0], [{ path: '/workspace/project', strictFileIsolation: true }, 'ubuntu']);
});

test('an unsupported backend cannot be presented as offering strict isolation', async () => {
  capability.mockResolvedValue({ ok: true, json: async () => ({ available: false }) });
  await pathStep();
  assert.equal((screen.getByRole('checkbox') as HTMLInputElement).disabled, true);
});
