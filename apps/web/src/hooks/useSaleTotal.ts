import { useState, useCallback } from "react";

function readTotal(username: string): number {
  const raw = localStorage.getItem(`sale_total_${username}`);
  return raw ? parseFloat(raw) || 0 : 0;
}

export function useSaleTotal(username: string) {
  const [saleTotal, setSaleTotal] = useState<number>(() =>
    readTotal(username),
  );

  const addAmount = useCallback(
    (amount: number) => {
      setSaleTotal((prev) => {
        const next = prev + amount;
        localStorage.setItem(`sale_total_${username}`, next.toString());
        return next;
      });
    },
    [username],
  );

  const reset = useCallback(() => {
    localStorage.removeItem(`sale_total_${username}`);
    setSaleTotal(0);
  }, [username]);

  return { saleTotal, addAmount, reset };
}
