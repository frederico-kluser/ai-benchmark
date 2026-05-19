import { useEffect, useState } from 'react';
import type { ValidateKeyResponse } from '../api';
import { getStoredKey, setStoredKey, validateKey } from '../api';

interface Props {
  onSaved?: () => void;
  compact?: boolean;
}

type Status = 'idle' | 'validating' | 'valid' | 'invalid';

function usd(v: number): string {
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function describeKey(res: ValidateKeyResponse): string {
  const parts: string[] = ['Key válida'];
  if (res.label) parts.push(`(${res.label})`);
  if (typeof res.usageUsd === 'number') {
    const limit =
      res.limitUsd === null || res.limitUsd === undefined
        ? 'sem limite'
        : `limite ${usd(res.limitUsd)}`;
    parts.push(`— uso ${usd(res.usageUsd)} / ${limit}`);
  }
  if (res.isFreeTier) parts.push('· tier gratuito');
  return parts.join(' ') + '.';
}

export function KeySetup({ onSaved, compact }: Props) {
  const [key, setKey] = useState(getStoredKey());
  const [status, setStatus] = useState<Status>(getStoredKey() ? 'valid' : 'idle');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setKey(getStoredKey());
  }, []);

  async function handleValidate(rawKey?: string) {
    const target = (rawKey ?? key).trim();
    if (!target) {
      setStatus('invalid');
      setMessage('Cole sua key do OpenRouter.');
      return;
    }
    setStatus('validating');
    setMessage(null);
    try {
      const res = await validateKey(target);
      if (res.ok) {
        setStoredKey(target);
        setStatus('valid');
        setMessage(describeKey(res));
        onSaved?.();
      } else {
        setStoredKey('');
        setStatus('invalid');
        setMessage(res.error ?? 'Key invalida.');
      }
    } catch (err) {
      setStatus('invalid');
      setMessage((err as Error).message);
    }
  }

  function handleClear() {
    setStoredKey('');
    setKey('');
    setStatus('idle');
    setMessage(null);
  }

  return (
    <div className={`key-setup ${compact ? 'compact' : ''}`}>
      {!compact && (
        <>
          <h1>OpenRouter API Key</h1>
          <p className="muted">
            Cole sua key do{' '}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
              OpenRouter
            </a>
            . Ela fica salva no <code>localStorage</code> do seu navegador e e enviada ao backend
            apenas em requests desta tela.
          </p>
        </>
      )}

      <div className="key-input-row">
        <input
          type="password"
          autoComplete="off"
          placeholder="sk-or-v1-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text').trim();
            if (pasted) {
              setKey(pasted);
              setTimeout(() => handleValidate(pasted), 0);
              e.preventDefault();
            }
          }}
        />
        <button
          type="button"
          className="primary"
          disabled={status === 'validating'}
          onClick={() => handleValidate()}
        >
          {status === 'validating' ? 'Validando…' : 'Validar e salvar'}
        </button>
        {status === 'valid' && (
          <button type="button" className="ghost" onClick={handleClear}>
            Remover
          </button>
        )}
      </div>

      {message && (
        <div
          className={
            status === 'valid' ? 'key-status ok' : status === 'invalid' ? 'key-status err' : 'key-status'
          }
        >
          {message}
        </div>
      )}

      {!compact && status === 'valid' && (
        <p className="muted small">Tudo certo — você já pode criar uma nova run.</p>
      )}
    </div>
  );
}

export function KeyGate({ children }: { children: React.ReactNode }) {
  const [hasKey, setHasKey] = useState(!!getStoredKey());
  if (!hasKey) {
    return (
      <div className="page">
        <KeySetup onSaved={() => setHasKey(true)} />
      </div>
    );
  }
  return <>{children}</>;
}
