import { useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { Backdrop, useFocusTrap, useScrollLock } from '@/components/motion-ui/overlay';
import { useMotionUITransition, useMotionUITheme } from '@/components/motion-ui/ui-theme';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Nome acessível do diálogo. */
  label: string;
  /** Onde o foco pousa ao abrir (o campo de busca, tipicamente). */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}

/**
 * Diálogo centrado sobre os primitivos de `@motion/overlay` (armadilha de foco,
 * trava de rolagem e scrim), com a entrada no token "ui" do tema. É a base do
 * tutorial e do seletor de modelos — o catálogo entrega os primitivos, não o
 * diálogo montado.
 */
export function Modal({ open, onClose, label, initialFocus, className, children }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const ui = useMotionUITransition('ui');
  const { motionMode } = useMotionUITheme();
  const still = motionMode === 'off';
  const travel = motionMode === 'full' ? 12 : 0;

  useScrollLock(open);
  useFocusTrap({ active: open, container: panel, onEscape: onClose, initialFocus, restoreFocus: true });

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-start justify-center px-4 py-[10vh]">
          <Backdrop
            onClick={onClose}
            className="bg-[color-mix(in_srgb,var(--background)_70%,transparent)] backdrop-blur-[2px]"
            initial={still ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: still ? 0 : ui.duration }}
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            initial={still ? false : { opacity: 0, transform: `translateY(${travel}px) scale(0.985)` }}
            animate={{ opacity: 1, transform: 'translateY(0px) scale(1)' }}
            exit={still ? { opacity: 1 } : { opacity: 0, transform: `translateY(${travel / 2}px) scale(0.99)` }}
            transition={still ? { duration: 0 } : ui}
            className={cn(
              'relative flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl',
              className,
            )}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Fechar"
              onClick={onClose}
              className="absolute top-3 right-3 z-10 text-muted-foreground"
            >
              <X aria-hidden="true" />
            </Button>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
