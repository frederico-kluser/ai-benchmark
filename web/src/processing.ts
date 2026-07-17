import { createContext, useContext, useState, useCallback, useMemo } from 'react';

export interface ProcessingApi {
  isProcessing: boolean;
  setIsProcessing: (value: boolean) => void;
}

export const ProcessingContext = createContext<ProcessingApi>({
  isProcessing: false,
  setIsProcessing: () => {},
});

export function useProcessing(): ProcessingApi {
  return useContext(ProcessingContext);
}

export function useProcessingState(): ProcessingApi {
  const [isProcessing, setIsProcessing] = useState(false);
  const setProcessing = useCallback((value: boolean) => {
    setIsProcessing(value);
  }, []);

  return useMemo(
    () => ({
      isProcessing,
      setIsProcessing: setProcessing,
    }),
    [isProcessing, setProcessing]
  );
}
