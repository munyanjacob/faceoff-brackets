# Bracket Polling Application — MVP Scope

## 1. Product Overview

A web application where users create timed, head-to-head voting brackets around arbitrary topics. Creators manually enter items, and each item can contain text, an image, or both. People vote on matchups, optionally leaving comments. At the end of each round, the item with the most votes automatically advances.

The MVP focuses on the core bracket/polling experience. AI-generated bracket content is out of scope for the MVP, but the architecture should leave room for adding it later.

## 2. Core Product Decisions

| Area | MVP Decision |
|---|---|
| Accounts | Required to create brackets |
| Voting accounts | Creator chooses whether voters must have an account |
| Visibility | Creator chooses public or private |
| Item creation | Manual entry only |
| Item content | Text, image, or both |
| Number of items | Any reasonable number |
| Uneven brackets | Automatically handled with byes |
| Matchups | Head-to-head |
| Voting | One choice per voter per matchup |
| Comments | Optional comment with a vote |
| Winner | Most votes wins |
| Round duration | Default duration for all rounds |
| Per-round duration | Creator can override individual rounds |
| Start time | Immediately by default; optional scheduled start |
| Tie handling | Tie-breaker vote, then random fallback |
| AI generation | Not in MVP |

## 3. Users and Permissions

### Bracket Creator

A registered user can:
- Create a bracket
- Add/edit bracket information before publishing
- Add items manually
- Upload an image for an item
- Choose public or private visibility
- Choose whether voting requires an account
- Set a default round duration
- Customize individual round durations
- Choose immediate or scheduled start
- Publish the bracket
- View live voting results
- View completed rounds and the eventual winner

### Voter

Depending on the creator's settings, a voter can:
- Open a public bracket or access a private bracket through its link
- View the current round
- View the two items in a matchup
- Vote for one item
- Optionally leave a comment with the vote
- View results when available

A voter cannot vote more than once in the same matchup.

## 4. Bracket Creation

Creator flow:

1. Sign in.
2. Select Create Bracket.
3. Enter a title.
4. Optionally enter a description.
5. Choose Public or Private.
6. Choose whether voting requires an account.
7. Add items.
8. For each item, enter a name/title and optional description and image.
9. Choose a default round duration.
10. Optionally customize individual round durations.
11. Choose Start Immediately or Schedule Start.
12. Review the generated bracket.
13. Publish.

Once a bracket starts, its structure is locked.

## 5. Bracket Items

Each item supports:
- Required name/title
- Optional image
- Optional descriptive text

Examples include albums, movies, restaurants, games, products, photos, or anything else the creator wants to compare.

Keep item metadata intentionally simple for the MVP.

## 6. Bracket Generation

Creators may enter any reasonable number of items.

Examples:
- 4 items → 2 first-round matchups
- 8 items → 4 first-round matchups
- 10 items → automatic byes
- 16 items → 8 first-round matchups

When the item count is not a power of two, the application automatically generates appropriate byes. An item receiving a bye advances without a vote.

The creator sees the generated structure before publishing.

## 7. Voting

Each matchup is head-to-head.

The voter sees:
- Item A
- Item B
- A vote action for each
- Optional comment field

A voter can submit a vote for exactly one item.

The MVP should use a practical mechanism to discourage duplicate anonymous votes, such as a browser/session identifier. This is a casual polling application, not an election-grade voting system.

## 8. Comments

Comments are optional and attached to the specific vote/matchup.

A voter can submit:
- Vote only
- Vote + comment

Do not implement comment replies, likes, profiles, or elaborate discussion features in the MVP.

## 9. Round Timing

The creator chooses a default duration for all rounds.

Example:
- Default: 24 hours

Individual rounds may override the default:
- Round 1: 24 hours
- Round 2: 24 hours
- Semifinals: 48 hours
- Final: 72 hours

If no override exists, the default duration applies.

### Starting

Default behavior:
> Publish → bracket starts immediately.

Optional behavior:
> Publish → bracket begins at a scheduled date/time.

Before a scheduled bracket starts, users see that it has not started and when it will begin.

## 10. Round Advancement

When a round expires:

1. Stop accepting votes.
2. Determine the winner of every matchup.
3. Advance winners.
4. Generate the next round.
5. Start the next round using its configured duration.
6. Repeat until one champion remains.

Advancement is automatic; the creator does not need to manually start each round.

## 11. Tie Handling

For the MVP, use a short **tie-breaker vote**.

Recommended behavior:
- A tied matchup enters a tie-breaker period.
- The tie-breaker lasts 25% of the normal round duration, with a minimum of 1 hour.
- If the tie-breaker is also tied, randomly select the winner as a final fallback.

Why this choice:
- Random selection alone feels arbitrary.
- Creator intervention would undermine the automated nature of the product.
- Leaving a tie unresolved can stall the entire bracket.
- A tie-breaker preserves community voting while guaranteeing that the tournament eventually progresses.

## 12. Public and Private Brackets

### Public

Public brackets can appear in a simple public discovery page.

MVP discovery can include:
- Recent brackets
- Active brackets
- Completed brackets

No recommendation algorithm is needed.

### Private

Private brackets do not appear in public discovery. They are accessed through a unique shareable link.

Anyone with the private link can access it, subject to the creator's voting-account requirement.

No invitation/friend system is needed.

## 13. Bracket Viewer

The main bracket page should show:

### Header
- Title
- Description
- Creator
- Status
- Current round
- Countdown timer

### Current Matchup

A clear side-by-side presentation:

```text
┌─────────────────┐       ┌─────────────────┐
│                 │       │                 │
│      IMAGE      │       │      IMAGE      │
│                 │       │                 │
│     Item A      │       │     Item B      │
│                 │       │                 │
└─────────────────┘       └─────────────────┘

       [ VOTE ]                 [ VOTE ]

              [ Optional comment ]

Voting should be the dominant action on the page.

Results

For the MVP:

After voting, show the current matchup's results.
Once a matchup closes, its results remain visible.
Completed matchups show the winner and vote totals.
14. Completed Bracket

The completed bracket should visually show the tournament path and champion.

Example:

Round 1          Semifinal          Final

A ─────┐
       ├─ A ─────┐
B ─────┘         │
                 ├─ A ───── Champion
C ─────┐         │
       ├─ C ─────┘
D ─────┘

Completed matchups should identify:

Winner
Losing item
Vote totals
Comments where applicable
15. Authentication

Authentication is required to create brackets.

MVP capabilities:

Sign up
Log in
Log out

Social login is not required.

Accounts primarily establish bracket ownership and creator permissions.

16. Creator Dashboard

A basic dashboard lists the user's brackets:

Drafts
Scheduled
Active
Completed

Each entry shows:

Title
Status
Current round
Creation date
Link to view/manage

The creator can open an active bracket to see its status and results.

17. Suggested Data Model
User
id
email
password/auth-provider information
created_at
Bracket
id
creator_id
title
description
visibility
voting_requirement
default_round_duration
scheduled_start_at
status
created_at
published_at
BracketItem
id
bracket_id
title
description
image_url
created_at
Round
id
bracket_id
round_number
duration
starts_at
ends_at
status
Matchup
id
round_id
item_a_id
item_b_id
winner_item_id
status
Vote
id
matchup_id
item_id
user_id (nullable for anonymous voting)
anonymous_voter_identifier (nullable)
comment
created_at

Keep brackets, rounds, matchups, items, and votes as separate concepts. The exact schema can change during implementation.

18. Important Business Rules
Only authenticated users can create brackets.
Only the creator can modify a bracket before it starts.
Once a bracket starts, its structure is locked.
Items cannot be added or removed after the bracket begins.
A voter can vote only once per matchup.
A vote belongs to exactly one matchup and one selected item.
A matchup accepts votes only while its round is active.
When the round expires, voting closes.
The item with the most votes advances.
Ties trigger the tie-breaker process.
Byes automatically advance an item.
The final remaining item is the champion.
Private brackets are excluded from public discovery.
Scheduled brackets cannot accept votes before their start time.
19. MVP Explicitly Out of Scope

Do not build initially:

AI-generated brackets
AI-generated descriptions
AI image generation
Social login
Following/friend systems
Notifications
Native mobile apps
Native camera integration
Complex recommendation algorithms
Advanced analytics
Paid brackets
Advertising
Cross-bracket rankings
Multiple voting methods
Ranked-choice voting
Multi-item matchups
Comment replies
Comment likes
Chat
Advanced moderation
Custom bracket themes
External embeds

These can be future features.

20. Future AI Extension

The architecture should eventually support prompts such as:

"Create a 16-item bracket comparing the best Quentin Tarantino movies."

The AI should generate a proposed list, but the creator should review/edit it before publishing.

Potential future AI features:

Generate bracket ideas
Generate item descriptions
Suggest images
Summarize voting results
Explain surprising matchup results

None are required for MVP.

21. Recommended Development Order
Phase 1 — Foundation
Project setup
Database
Authentication
User model
Phase 2 — Bracket Creation
Create bracket form
Add/edit/remove items
Image upload
Public/private setting
Voting-access setting
Duration configuration
Immediate/scheduled start
Phase 3 — Bracket Engine
Generate brackets
Handle arbitrary item counts
Generate byes
Create rounds
Create matchups
Advance winners
Phase 4 — Voting
Display matchup
Vote
Optional comment
Prevent duplicate voting
Record vote totals
Phase 5 — Timing
Round countdown
Round expiration
Automatic advancement
Next-round creation
Scheduled starts
Tie-breaker handling
Phase 6 — Results
Full bracket visualization
Current results
Completed matchups
Champion display
Creator dashboard
Phase 7 — Polish
Responsive UI
Error handling
Loading states
Empty states
Validation
Automated tests
Basic security/abuse protections
22. Definition of Done

The MVP is complete when a user can:

Create an account.
Create a bracket.
Enter any reasonable number of text/image items.
Choose public/private visibility.
Choose whether voting requires an account.
Set a default round duration.
Customize individual round durations.
Publish immediately or schedule the bracket.
Share the resulting bracket link.
Have other users vote on head-to-head matchups.
Allow voters to optionally leave comments.
Prevent duplicate votes.
Automatically close each round.
Automatically advance winners.
Correctly handle byes.
Correctly handle ties.
Automatically start subsequent rounds.
Determine a champion.
Display the completed bracket and results.
Allow the creator to view and manage their brackets.
23. Product Philosophy

Make a tournament in two minutes, send the link, and let people decide.

The MVP should prioritize:

Simple bracket creation
Extremely clear voting
Automatic progression
Easy sharing
Arbitrary topics
Text + image content
Minimal configuration

It should not attempt to become a full social network or sophisticated tournament-management platform in its first release.