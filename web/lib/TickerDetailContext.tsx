"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { PriceData, FundamentalsData, DepthBook, Trade, OptionContract } from "@/lib/pricesProtocol";
import type { OrdersData, PortfolioData } from "@/lib/types";

type TickerDetailContextValue = {
  activeTicker: string | null;
  activePositionId: number | null;
  setActiveTicker: (ticker: string | null) => void;
  setActivePositionId: (id: number | null) => void;
  getPrices: () => Record<string, PriceData>;
  getFundamentals: () => Record<string, FundamentalsData>;
  getPortfolio: () => PortfolioData | null;
  getOrders: () => OrdersData | null;
  getDepths: () => Record<string, DepthBook>;
  getTape: () => Record<string, Trade[]>;
  setPrices: (p: Record<string, PriceData>) => void;
  setFundamentals: (f: Record<string, FundamentalsData>) => void;
  setPortfolio: (p: PortfolioData | null) => void;
  setOrders: (o: OrdersData | null) => void;
  setDepths: (d: Record<string, DepthBook>) => void;
  setTape: (t: Record<string, Trade[]>) => void;
  chainContracts: OptionContract[];
  setChainContracts: (c: OptionContract[]) => void;
  /** Book key the detail view wants L2 depth for. Drives `usePrices` upstream. */
  depthSymbol: string | null;
  setDepthSymbol: (key: string | null) => void;
};

const TickerDetailContext = createContext<TickerDetailContextValue | null>(null);

export function TickerDetailProvider({ children }: { children: ReactNode }) {
  const [activeTicker, setActiveTickerState] = useState<string | null>(null);
  const [activePositionId, setActivePositionIdState] = useState<number | null>(null);
  const [chainContracts, setChainContractsState] = useState<OptionContract[]>([]);
  const [depthSymbol, setDepthSymbolState] = useState<string | null>(null);
  const pricesRef = useRef<Record<string, PriceData>>({});
  const fundamentalsRef = useRef<Record<string, FundamentalsData>>({});
  const portfolioRef = useRef<PortfolioData | null>(null);
  const ordersRef = useRef<OrdersData | null>(null);
  const depthsRef = useRef<Record<string, DepthBook>>({});
  const tapeRef = useRef<Record<string, Trade[]>>({});

  const setActiveTicker = useCallback((ticker: string | null) => {
    setActiveTickerState(ticker ? ticker.toUpperCase() : null);
    if (!ticker) {
      setActivePositionIdState(null);
      setChainContractsState([]);
      setDepthSymbolState(null);
    }
  }, []);

  const setActivePositionId = useCallback((id: number | null) => {
    setActivePositionIdState(id);
  }, []);

  const setChainContracts = useCallback((c: OptionContract[]) => {
    setChainContractsState(c);
  }, []);

  const setDepthSymbol = useCallback((key: string | null) => {
    setDepthSymbolState((prev) => (prev === key ? prev : key));
  }, []);

  const getPrices = useCallback(() => pricesRef.current, []);
  const getFundamentals = useCallback(() => fundamentalsRef.current, []);
  const getPortfolio = useCallback(() => portfolioRef.current, []);
  const getOrders = useCallback(() => ordersRef.current, []);
  const getDepths = useCallback(() => depthsRef.current, []);
  const getTape = useCallback(() => tapeRef.current, []);

  const setPrices = useCallback((p: Record<string, PriceData>) => {
    pricesRef.current = p;
  }, []);

  const setFundamentals = useCallback((f: Record<string, FundamentalsData>) => {
    fundamentalsRef.current = f;
  }, []);

  const setPortfolio = useCallback((p: PortfolioData | null) => {
    portfolioRef.current = p;
  }, []);

  const setOrders = useCallback((o: OrdersData | null) => {
    ordersRef.current = o;
  }, []);

  const setDepths = useCallback((d: Record<string, DepthBook>) => {
    depthsRef.current = d;
  }, []);

  const setTape = useCallback((t: Record<string, Trade[]>) => {
    tapeRef.current = t;
  }, []);

  return (
    <TickerDetailContext.Provider
      value={{ activeTicker, activePositionId, setActiveTicker, setActivePositionId, getPrices, getFundamentals, getPortfolio, getOrders, getDepths, getTape, setPrices, setFundamentals, setPortfolio, setOrders, setDepths, setTape, chainContracts, setChainContracts, depthSymbol, setDepthSymbol }}
    >
      {children}
    </TickerDetailContext.Provider>
  );
}

export function useTickerDetail(): TickerDetailContextValue {
  const ctx = useContext(TickerDetailContext);
  if (!ctx) throw new Error("useTickerDetail must be used within TickerDetailProvider");
  return ctx;
}
