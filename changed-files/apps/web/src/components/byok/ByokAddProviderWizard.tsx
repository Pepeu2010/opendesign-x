import { useEffect, useMemo, useRef, useState } from 'react';
import type { KnownProvider } from '../../state/config';
import { SearchableModelSelect } from '../modelOptions';

/**
 * Which of the three ways a user is adding a model endpoint.
 *
 * This is the entry decision for the whole BYOK surface, so it is modelled as a
 * distinct state rather than inferred from whether a base URL happens to be
 * filled in. An empty base URL with a chosen known provider is a legitimate
 * intermediate state, and inferring the intent there would collapse the user
 * back to step 1 while they are still filling in the provider.
 */
export type AddProviderPath = 'known' | 'custom' | 'local';

interface ByokAddProviderWizardProps {
  /** Providers filtered to the currently selected protocol. */
  providers: KnownProvider[];
  /** Provider the current draft resolves to, if any. */
  selectedProviderIndex: number;
  /** Current protocol, so each path can explain itself in the user's terms. */
  protocol: string;
  labels: {
    title: string;
    subtitle: string;
    step: string;
    knownTitle: string;
    knownBody: string;
    customTitle: string;
    customBody: string;
    localTitle: string;
    localBody: string;
    recommended: string;
    back: string;
    providerLabel: string;
    providerSearch: string;
    emptyProviders: string;
  };
  onProviderSelect: (provider: KnownProvider) => void;
  onCustomSelected: () => void;
  onLocalSelected: () => void;
}

/**
 * Three-path entry for adding a model endpoint.
 *
 * The previous surface was a single dropdown that mixed every known provider
 * with one "custom" entry, which made the local-model case (an OpenAI-compatible
 * server on loopback that needs no API key) indistinguishable from a hosted
 * provider the user has no key for yet. Splitting the entry into three explicit
 * paths lets each one carry only the fields it actually needs.
 */
export function ByokAddProviderWizard({
  providers,
  selectedProviderIndex,
  protocol,
  labels,
  onProviderSelect,
  onCustomSelected,
  onLocalSelected,
}: ByokAddProviderWizardProps) {
  const [path, setPath] = useState<AddProviderPath | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the new step's heading so keyboard and screen-reader users
  // land on the content that replaced the button they activated.
  useEffect(() => {
    if (path != null) headingRef.current?.focus();
  }, [path]);

  const knownCount = providers.length;
  const localProviders = useMemo(
    () => providers.filter((provider) => isLocalProvider(provider)),
    [providers],
  );

  if (path === null) {
    return (
      <section className="byok-add-wizard" data-testid="byok-add-provider-wizard">
        <header className="byok-add-wizard__header">
          <h3 className="byok-add-wizard__title">{labels.title}</h3>
          <p className="byok-add-wizard__subtitle">{labels.subtitle}</p>
        </header>
        <div className="byok-add-wizard__paths" role="list">
          <button
            type="button"
            role="listitem"
            className="byok-add-wizard__path"
            data-testid="byok-path-known"
            onClick={() => setPath('known')}
          >
            <span className="byok-add-wizard__path-head">
              <span className="byok-add-wizard__path-title">{labels.knownTitle}</span>
              <span className="byok-add-wizard__badge">{labels.recommended}</span>
            </span>
            <span className="byok-add-wizard__path-body">{labels.knownBody}</span>
            <span className="byok-add-wizard__path-meta">{`${knownCount} · ${protocol}`}</span>
          </button>
          <button
            type="button"
            role="listitem"
            className="byok-add-wizard__path"
            data-testid="byok-path-custom"
            onClick={() => setPath('custom')}
          >
            <span className="byok-add-wizard__path-head">
              <span className="byok-add-wizard__path-title">{labels.customTitle}</span>
            </span>
            <span className="byok-add-wizard__path-body">{labels.customBody}</span>
          </button>
          <button
            type="button"
            role="listitem"
            className="byok-add-wizard__path"
            data-testid="byok-path-local"
            onClick={() => setPath('local')}
          >
            <span className="byok-add-wizard__path-head">
              <span className="byok-add-wizard__path-title">{labels.localTitle}</span>
            </span>
            <span className="byok-add-wizard__path-body">{labels.localBody}</span>
            <span className="byok-add-wizard__path-meta">{localProviders.length > 0 ? localProviders.map((p) => p.label).join(' · ') : ''}</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="byok-add-wizard" data-testid="byok-add-provider-wizard">
      <header className="byok-add-wizard__header">
        <button
          type="button"
          className="byok-add-wizard__back"
          data-testid="byok-wizard-back"
          onClick={() => setPath(null)}
        >
          {labels.back}
        </button>
        <h3 className="byok-add-wizard__title" tabIndex={-1} ref={headingRef}>
          {path === 'known' ? labels.knownTitle : path === 'custom' ? labels.customTitle : labels.localTitle}
        </h3>
        <p className="byok-add-wizard__subtitle">
          {path === 'known' ? labels.knownBody : path === 'custom' ? labels.customBody : labels.localBody}
        </p>
      </header>
      {path === 'known' ? (
        knownCount > 0 ? (
          <label className="byok-add-wizard__field">
            <span className="byok-add-wizard__field-label">{labels.providerLabel}</span>
            <SearchableModelSelect
              className="inline-switcher__select settings-model-select settings-model-select--byok"
              aria-label={labels.providerLabel}
              searchPlaceholder={labels.providerSearch}
              popoverTestId="settings-byok-provider-preset-popover"
              popoverClassName="settings-byok-select-popover"
              minSearchableOptions={Number.POSITIVE_INFINITY}
              models={providers.map((provider, index) => ({
                id: String(index),
                label: provider.label,
              }))}
              value={selectedProviderIndex >= 0 ? String(selectedProviderIndex) : ''}
              onChange={(value) => {
                const idx = Number(value);
                if (!Number.isNaN(idx) && providers[idx]) onProviderSelect(providers[idx]!);
              }}
            />
          </label>
        ) : (
          <p className="byok-add-wizard__empty" data-testid="byok-known-empty">
            {labels.emptyProviders}
          </p>
        )
      ) : null}
      {path === 'custom' ? (
        <button
          type="button"
          className="byok-add-wizard__confirm"
          data-testid="byok-custom-confirm"
          onClick={onCustomSelected}
        >
          {labels.customTitle}
        </button>
      ) : null}
      {path === 'local' ? (
        <div className="byok-add-wizard__choices">
          {localProviders.length > 0 ? (
            localProviders.map((provider) => (
              <button
                key={provider.label}
                type="button"
                className="byok-add-wizard__confirm"
                data-testid={`byok-local-${provider.label}`}
                onClick={() => onProviderSelect(provider)}
              >
                {provider.label}
              </button>
            ))
          ) : (
            <button
              type="button"
              className="byok-add-wizard__confirm"
              data-testid="byok-local-confirm"
              onClick={onLocalSelected}
            >
              {labels.localTitle}
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

function isLocalProvider(provider: KnownProvider): boolean {
  return provider.requiresApiKey === false || /127\.0\.0\.1|localhost/.test(provider.baseUrl);
}
