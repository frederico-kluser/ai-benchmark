import { useEffect, useState } from 'react';
import type { ValidateKeyResponse } from '../api';
import { getStoredKey, setStoredKey, validateKey } from '../api';

type Status = 'idle' | 'validating' | 'valid' | 'invalid';

function usd(v: number): string {
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function describeKey(res: ValidateKeyResponse): string {
  const parts: string[] = ['✓ Key válida'];
  if (res.label) parts.push(`(${res.label})`);
  if (typeof res.usageUsd === 'number') {
    const limit =
      res.limitUsd === null || res.limitUsd === undefined ? 'sem limite' : `limite ${usd(res.limitUsd)}`;
    parts.push(`— uso ${usd(res.usageUsd)} / ${limit}`);
  }
  if (res.isFreeTier) parts.push('· tier gratuito');
  return parts.join(' ') + '.';
}

export function KeySetup({ onSaved }: { onSaved?: () => void }) {
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
        setMessage(res.error ?? 'Key inválida.');
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

  const statusClass = status === 'valid' ? 'ok' : status === 'invalid' ? 'err' : 'neutral';

  return (
    <div className="card settings-card">
      <div className="settings-title">OpenRouter API Key</div>
      <div className="settings-desc">
        Cole sua key do OpenRouter. Ela fica salva no <code>localStorage</code> do seu navegador e é
        enviada ao backend apenas nas requisições que precisam dela.{' '}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
          openrouter.ai/keys&nbsp;↗
        </a>
      </div>

      <div className="key-row">
        <input
          className="input input-mono"
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
          className="key-validate"
          disabled={status === 'validating'}
          onClick={() => handleValidate()}
        >
          {status === 'validating' ? 'Validando…' : 'Validar e salvar'}
        </button>
        {status === 'valid' && (
          <button type="button" className="btn-secondary" onClick={handleClear}>
            Remover
          </button>
        )}
      </div>

      {message && <div className={`key-status ${statusClass}`}>{message}</div>}
    </div>
  );
}

export function KeyGate({ children }: { children: React.ReactNode }) {
  const [hasKey, setHasKey] = useState(!!getStoredKey());
  if (!hasKey) {
    return (
      <div className="screen">
        <h1 className="page-title">Conecte sua chave</h1>
        <p className="page-sub">
          Para criar uma run, cole sua chave da OpenRouter. Ela fica salva só no seu navegador.
        </p>
        <KeySetup onSaved={() => setHasKey(true)} />
      </div>
    );
  }
  return <>{children}</>;
}
