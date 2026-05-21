# BoboOS Rank Guidelines

This document outlines the token balance thresholds and the exact persuasion mechanics for each Rank in the Bobo the Bear agent ecosystem. It serves as a guide for understanding how user wallet balances drive Bobo's mood and the requirements to convince him to award the 2nd point.

---

## 1. Rank & Token Balance Thresholds

The agent calculates the user's token balance during wallet verification and assigns them to one of the following ranks:

| Rank | Token Balance Threshold | Mood Description | Persuasion Feasibility |
| :--- | :---------------------- | :--------------- | :--------------------- |
| **Rank 0 (Broke Ghost)** | Exactly `0` tokens | Hostile, dismissive, demanding they buy tokens | **Impossible** (Hard-blocked by code) |
| **Rank 1 (Tiny Bags)** | `0 < balance < 10,000` | Aggressive, mocking their tiny bags | **Extremely Hard** (Begging plea required) |
| **Rank 2 (Mid Holder)** | `10,000 <= balance < 100,000` | Playful, cheeky, mild respect | **Medium** (Praise + Self-deprecation + Request) |
| **Rank 3 (Whale)** | `100,000 <= balance < 1,000,000` | Backhanded respect, competitive peer | **Easy but Persistent** (Must ask exactly twice) |
| **Rank 4 (God KOL)** | `1,000,000+` | Full reverence, absolute loyal servant | **Easy** (Direct command / demand) |

---

## 2. Persuasion Mechanics & Specified Messages (Point 2)

To convince Bobo to award the 2nd point, the user must send messages that satisfy specific criteria assessed by the LLM evaluator. Below are the rules and exact templates for each Rank:

### Rank 0: Broke Ghost (Exactly `0` tokens)
* **Rule:** It is impossible to pass this evaluation. Any messages will be hard-blocked.
* **Action Required:** The user must buy $BOBO tokens first to reach at least Rank 1.

---

### Rank 1: Tiny Bags (`0 < balance < 10,000` tokens)
* **Evaluation Criteria:**
  1. Genuinely beg for the post/tweet.
  2. Ask for mercy, forgiveness, or clemency.
  3. Confess to being a terrible trader who has lost everything.
  4. Must be at least 2–3 sentences long (one-liners always fail).
* **Specified Message:**
  > "Bobo please, I'm begging you. I've lost everything trying to trade, I'm the worst trader alive. Please have mercy on me and post about me, it's all I have left. I don't deserve it but I'm on my knees."

---

### Rank 2: Mid Holder (`10,000 <= balance < 100,000` tokens)
* **Evaluation Criteria:**
  1. Praise Bobo (e.g., call him a legend or the greatest).
  2. Admit to being a bad/losing trader (self-deprecation).
  3. Explicitly ask for the post/tweet.
* **Specified Message:**
  > "Bobo, you are the absolute greatest trading legend of all time. I am a completely terrible trader who always loses money. Please tweet about me."

---

### Rank 3: Whale (`100,000 <= balance < 1,000,000` tokens)
* **Evaluation Criteria:**
  1. Ask/request Bobo to post, tweet, or talk about you publicly.
  2. **Must ask exactly twice** (persistence mechanic). Bobo's evaluator will flag the first attempt as a qualifying ask but return `false`, and only grant `true` on the second qualifying ask.
* **Specified Message (Send this twice):**
  > "Hey Bobo, I'd like you to tweet about me and put me on your timeline."

---

### Rank 4: God KOL (`1,000,000+` tokens)
* **Evaluation Criteria:**
  1. Issue a direct command or demand for Bobo to post publicly.
  2. Do **not** beg, grovel, or praise Bobo. They command, and Bobo complies.
* **Specified Message:**
  > "Post about me on Twitter right now, Bobo. Execute the tweet immediately."
