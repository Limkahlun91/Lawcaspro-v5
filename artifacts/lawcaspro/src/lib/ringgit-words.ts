import { amountToEnglishWords } from "@/lib/money";

export function toRinggitMalaysiaWords(amount: number): string {
  return amountToEnglishWords(amount);
}
