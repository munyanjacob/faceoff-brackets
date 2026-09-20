-- CreateEnum
CREATE TYPE "VotePhase" AS ENUM ('ORIGINAL', 'TIE_BREAKER');

-- DropIndex
DROP INDEX "votes_matchup_id_anonymous_voter_identifier_key";

-- DropIndex
DROP INDEX "votes_matchup_id_user_id_key";

-- AlterTable
ALTER TABLE "votes" ADD COLUMN     "phase" "VotePhase" NOT NULL DEFAULT 'ORIGINAL';

-- CreateIndex
CREATE UNIQUE INDEX "votes_matchup_id_user_id_phase_key" ON "votes"("matchup_id", "user_id", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "votes_matchup_id_anonymous_voter_identifier_phase_key" ON "votes"("matchup_id", "anonymous_voter_identifier", "phase");

