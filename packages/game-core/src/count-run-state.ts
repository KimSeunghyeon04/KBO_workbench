import type { CountRunObservation } from "@kbo/contracts";

type CountRunCellState = Pick<CountRunObservation, "outs" | "bases" | "balls" | "strikes">;

const BASE_STATES = 8;
const STRIKE_STATES = 3;
const COUNTS_PER_BASE_OUT = 4 * STRIKE_STATES;

export function countRunCellIndex({ outs, bases, balls, strikes }: CountRunCellState): number {
  return (outs * BASE_STATES + bases) * COUNTS_PER_BASE_OUT + balls * STRIKE_STATES + strikes;
}

export function countRunCellAt(index: number): CountRunCellState & { re24Index: number } {
  // Each RE24 state occupies one contiguous block of ball-strike counts.
  const re24Index = Math.floor(index / COUNTS_PER_BASE_OUT);
  return {
    re24Index,
    outs: Math.floor(re24Index / BASE_STATES),
    bases: re24Index % BASE_STATES,
    balls: Math.floor((index % COUNTS_PER_BASE_OUT) / STRIKE_STATES),
    strikes: index % STRIKE_STATES,
  };
}
