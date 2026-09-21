import { transport } from "./transport";
import type {
  Bracket,
  BracketDetail,
  BracketItem,
  BracketWithRounds,
  CreateBracketRequest,
  UpdateRoundDurationRequest,
  UpdateScheduleRequest,
  UpsertItemInput,
} from "./types";

/** Creator-owned bracket management. Everything here needs a session. */
export const bracketService = {
  listMine: (): Promise<BracketWithRounds[]> => transport.listMyBrackets(),
  create: (input: CreateBracketRequest): Promise<Bracket> => transport.createBracket(input),
  get: (bracketId: string): Promise<BracketDetail> => transport.getBracket(bracketId),
  listItems: (bracketId: string): Promise<BracketItem[]> => transport.listItems(bracketId),
  addItem: (bracketId: string, input: UpsertItemInput): Promise<BracketItem> =>
    transport.addItem(bracketId, input),
  updateItem: (bracketId: string, itemId: string, input: UpsertItemInput): Promise<BracketItem> =>
    transport.updateItem(bracketId, itemId, input),
  removeItem: (bracketId: string, itemId: string): Promise<void> =>
    transport.removeItem(bracketId, itemId),
  updateRoundDuration: (bracketId: string, input: UpdateRoundDurationRequest): Promise<Bracket> =>
    transport.updateRoundDuration(bracketId, input),
  updateSchedule: (bracketId: string, input: UpdateScheduleRequest): Promise<Bracket> =>
    transport.updateSchedule(bracketId, input),
  publish: (bracketId: string): Promise<Bracket> => transport.publish(bracketId),
};
