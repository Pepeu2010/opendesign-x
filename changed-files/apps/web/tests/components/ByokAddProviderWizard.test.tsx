// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ByokAddProviderWizard } from '../../src/components/byok/ByokAddProviderWizard';
import type { KnownProvider } from '../../src/state/config';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const labels = {
  title: 'Add a model or provider',
  subtitle: 'Choose a path.',
  step: 'Step 1 of 3',
  knownTitle: 'Known provider',
  knownBody: 'Pre-configured providers.',
  customTitle: 'Custom API',
  customBody: 'Any OpenAI-compatible endpoint.',
  localTitle: 'Local model',
  localBody: 'A local server that needs no key.',
  recommended: 'Recommended',
  back: 'Back',
  providerLabel: 'Provider',
  providerSearch: 'Search providers',
  emptyProviders: 'No provider available for this protocol.',
};

const hostedProvider: KnownProvider = {
  label: 'DeepSeek',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  preferredModels: ['deepseek-chat'],
};

const localProvider: KnownProvider = {
  label: 'LM Studio (local)',
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1:1234/v1',
  preferredModels: ['local-model'],
  requiresApiKey: false,
};

function renderWizard(overrides: Partial<Parameters<typeof ByokAddProviderWizard>[0]> = {}) {
  const onProviderSelect = vi.fn();
  const onCustomSelected = vi.fn();
  const onLocalSelected = vi.fn();
  render(
    <ByokAddProviderWizard
      providers={[hostedProvider, localProvider]}
      selectedProviderIndex={-1}
      protocol="openai"
      labels={labels}
      onProviderSelect={onProviderSelect}
      onCustomSelected={onCustomSelected}
      onLocalSelected={onLocalSelected}
      {...overrides}
    />,
  );
  return { onProviderSelect, onCustomSelected, onLocalSelected };
}

describe('ByokAddProviderWizard', () => {
  it('offers exactly the three documented entry paths', () => {
    renderWizard();

    expect(screen.getByTestId('byok-path-known')).toBeTruthy();
    expect(screen.getByTestId('byok-path-custom')).toBeTruthy();
    expect(screen.getByTestId('byok-path-local')).toBeTruthy();
  });

  it('does not report a selection until a path is chosen', () => {
    const spies = renderWizard();

    expect(spies.onProviderSelect).not.toHaveBeenCalled();
    expect(spies.onCustomSelected).not.toHaveBeenCalled();
    expect(spies.onLocalSelected).not.toHaveBeenCalled();
  });

  it('reveals the provider list only after the known-provider path is chosen', () => {
    renderWizard();

    // The picker is behind step 2, so it must not be present on step 1.
    expect(screen.queryByLabelText(labels.providerLabel)).toBeNull();

    fireEvent.click(screen.getByTestId('byok-path-known'));

    expect(screen.getByLabelText(labels.providerLabel)).toBeTruthy();
    expect(screen.getByTestId('byok-wizard-back')).toBeTruthy();
  });

  it('reports only the local providers on the local-model path', () => {
    const spies = renderWizard();

    fireEvent.click(screen.getByTestId('byok-path-local'));

    // LM Studio is local; the hosted provider must not be offered here.
    expect(screen.getByTestId('byok-local-LM Studio (local)')).toBeTruthy();
    expect(screen.queryByTestId('byok-local-DeepSeek')).toBeNull();

    fireEvent.click(screen.getByTestId('byok-local-LM Studio (local)'));
    expect(spies.onProviderSelect).toHaveBeenCalledWith(localProvider);
  });

  it('signals a custom endpoint without inventing a provider', () => {
    const spies = renderWizard();

    fireEvent.click(screen.getByTestId('byok-path-custom'));
    fireEvent.click(screen.getByTestId('byok-custom-confirm'));

    expect(spies.onCustomSelected).toHaveBeenCalledTimes(1);
    expect(spies.onProviderSelect).not.toHaveBeenCalled();
  });

  it('returns to the path list from a later step', () => {
    renderWizard();

    fireEvent.click(screen.getByTestId('byok-path-known'));
    fireEvent.click(screen.getByTestId('byok-wizard-back'));

    expect(screen.getByTestId('byok-path-known')).toBeTruthy();
    expect(screen.queryByTestId('byok-wizard-back')).toBeNull();
  });

  it('explains an empty provider list instead of rendering a dead picker', () => {
    renderWizard({ providers: [] });

    fireEvent.click(screen.getByTestId('byok-path-known'));

    expect(screen.getByTestId('byok-known-empty')).toBeTruthy();
    expect(screen.queryByLabelText(labels.providerLabel)).toBeNull();
  });

  it('falls back to asking for a local endpoint when no preset is local', () => {
    const spies = renderWizard({ providers: [hostedProvider] });

    fireEvent.click(screen.getByTestId('byok-path-local'));
    fireEvent.click(screen.getByTestId('byok-local-confirm'));

    expect(spies.onLocalSelected).toHaveBeenCalledTimes(1);
  });
});
