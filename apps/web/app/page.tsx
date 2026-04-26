"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import { getUserState, submitChat, pingAgentForWallet, wipeUserProgress, getLeaderboard } from "./actions";
import AsciiBobo from "../components/AsciiBobo";
import AsciiBoboMobile from "../components/AsciiBoboMobile";

// Fix hydration mismatch by only loading the WalletMultiButton on the client
const WalletMultiButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

// Meme images displayed while Bobo thinks — one picked at random per message
const BOBO_MEMES = [
  '/images/bobo_thinks.webp',
  '/images/bobo_thinks_2.png',
  '/images/bobo_thinks_3.png',
];

export default function Home() {
  const { publicKey, connected } = useWallet();
  const [userData, setUserData] = useState<any>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ sender: string, text: string, image?: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  // The meme shown while waiting for Bobo's reply (null = no meme)
  const [typingMeme, setTypingMeme] = useState<string | null>(null);

  const [cooldownTimeLeft, setCooldownTimeLeft] = useState<string | null>(null);

  // Controls the 6-second delay between winning point 2 and showing the Satisfied screen
  const [completionTransitioned, setCompletionTransitioned] = useState(false);

  // Leaderboard dropdown
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [leaderboard, setLeaderboard] = useState<{ rank: number; wallet: string; roasts_count: number }[]>([]);
  const [leaderboardLoaded, setLeaderboardLoaded] = useState(false);
  const leaderboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTributesMouseEnter = useCallback(async () => {
    if (leaderboardTimerRef.current) clearTimeout(leaderboardTimerRef.current);
    setShowLeaderboard(true);
    if (!leaderboardLoaded) {
      const data = await getLeaderboard();
      setLeaderboard(data);
      setLeaderboardLoaded(true);
    }
  }, [leaderboardLoaded]);

  const handleTributesMouseLeave = useCallback(() => {
    leaderboardTimerRef.current = setTimeout(() => setShowLeaderboard(false), 180);
  }, []);

  // Ref on the scroll container itself — scrollTop approach only scrolls
  // the chat div, never the page (scrollIntoView was causing logo cut-off)
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const hasPinged = useRef(false);

  // ── Draggable window — all refs, zero React re-renders during drag ─────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startMouse = useRef({ x: 0, y: 0 });
  const startPos = useRef({ x: 0, y: 0 });
  const currentPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages, isTyping]);

  const previousPublicKey = useRef<string | null>(null);

  useEffect(() => {
    if (connected && publicKey) {
      previousPublicKey.current = publicKey.toBase58();
    }
  }, [connected, publicKey]);

  useEffect(() => {
    if (!connected || !publicKey) {
      // If we just disconnected, wipe their session progress
      if (previousPublicKey.current) {
        wipeUserProgress(previousPublicKey.current).catch(console.error);
        previousPublicKey.current = null;
      }

      setUserData(null);
      setIsChatOpen(false);
      setChatMessages([]);
      hasPinged.current = false;
      return;
    }

    const interval = setInterval(async () => {
      try {
        const data = await getUserState(publicKey.toBase58());
        setUserData(data);

        // Update cooldown timer if they are in the roasted state
        if (data?.roast_published && data?.last_roast_published_at) {
          const publishedAt = new Date(data.last_roast_published_at).getTime();
          const unlockTime = publishedAt + (6 * 60 * 60 * 1000);
          const diff = unlockTime - Date.now();
          if (diff > 0) {
            const h = Math.floor(diff / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);
            setCooldownTimeLeft(`${h}h ${m}m ${s}s`);
          } else {
            setCooldownTimeLeft(null);
          }
        }

        // If they connected but aren't verified yet, ping the agent ONCE
        if (data && !data.point_one_verified && !hasPinged.current) {
          hasPinged.current = true;
          pingAgentForWallet(publicKey.toBase58()).catch(console.error);
        }
      } catch (err) {
        console.error("Polling error:", err);
      }
    }, 3000);

    // Initial fetch to set everything
    getUserState(publicKey.toBase58()).then(data => {
      setUserData(data);
      if (data?.roast_published && data?.last_roast_published_at) {
        const publishedAt = new Date(data.last_roast_published_at).getTime();
        const unlockTime = publishedAt + (6 * 60 * 60 * 1000);
        const diff = unlockTime - Date.now();
        if (diff > 0) {
          const h = Math.floor(diff / (1000 * 60 * 60));
          const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
          setCooldownTimeLeft(`${h}h ${m}m`);
        }
      }
    }).catch(console.error);

    return () => clearInterval(interval);
  }, [connected, publicKey]);

  // ── Drag helpers ────────────────────────────────────────────────────────────
  // Clamps x/y so no edge of the container can leave the viewport,
  // then writes the transform directly to the DOM (zero React re-renders).
  const applyPosition = useCallback((x: number, y: number) => {
    const el = containerRef.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // offsetWidth / offsetHeight give layout dimensions ignoring transform
    const maxX = Math.max(0, (vw - el.offsetWidth) / 2);
    const maxY = Math.max(0, (vh - el.offsetHeight) / 2);
    const cx = Math.min(Math.max(x, -maxX), maxX);
    const cy = Math.min(Math.max(y, -maxY), maxY);
    currentPos.current = { x: cx, y: cy };
    el.style.transform = `translate(${cx}px, ${cy}px)`;
  }, []);

  // ── Drag handlers ────────────────────────────────────────────────────────────
  const onDragHandleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    startMouse.current = { x: e.clientX, y: e.clientY };
    startPos.current = { ...currentPos.current };
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }, []);

  const onDragHandleTouchStart = useCallback((e: React.TouchEvent) => {
    isDragging.current = true;
    startMouse.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    startPos.current = { ...currentPos.current };
  }, []);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;
    applyPosition(
      startPos.current.x + (e.clientX - startMouse.current.x),
      startPos.current.y + (e.clientY - startMouse.current.y),
    );
  }, [applyPosition]);

  const onMouseUp = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    document.body.style.userSelect = '';
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    if (!isDragging.current) return;
    e.preventDefault(); // block iOS rubber-band while dragging
    applyPosition(
      startPos.current.x + (e.touches[0].clientX - startMouse.current.x),
      startPos.current.y + (e.touches[0].clientY - startMouse.current.y),
    );
  }, [applyPosition]);

  const onTouchEnd = useCallback(() => {
    isDragging.current = false;
  }, []);

  // Window-level listeners for drag tracking
  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [onMouseMove, onMouseUp, onTouchMove, onTouchEnd]);

  // Recenter the window whenever the chat opens or closes —
  // prevents the expanded panel from being stuck in an off-center corner.
  useEffect(() => {
    applyPosition(0, 0);
  }, [isChatOpen, applyPosition]);


  const handleChatSubmit = async () => {
    // Block double-sends: if bot hasn't replied yet, do nothing
    if (!chatInput.trim() || !publicKey || isTyping) return;

    const userMsg = chatInput;
    // Pick one meme at random to show while thinking
    const meme = BOBO_MEMES[Math.floor(Math.random() * BOBO_MEMES.length)];

    setChatMessages(prev => [...prev, { sender: "You", text: userMsg }]);
    setChatInput("");
    setTypingMeme(meme);
    setIsTyping(true);

    try {
      const res = await submitChat(publicKey.toBase58(), userMsg);
      setChatMessages(prev => [...prev, { sender: "Bobo", text: res.reply, image: res.image }]);
      if (res.readyToDump) {
        setTimeout(() => setCompletionTransitioned(true), 4000);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsTyping(false);
      setTypingMeme(null);
    }
  };

  return (
    <main className="flex flex-col items-center justify-center h-screen px-4 pb-4 pt-14 sm:p-4 bg-[#fee1bf] relative overflow-hidden">
      <AsciiBobo />
      {/* Mobile-only: top-right corner art — hidden on sm+ inside the component */}
      <AsciiBoboMobile />

      <div className="absolute top-2 left-2 right-2 md:top-4 md:left-4 md:right-4 z-50 pointer-events-none">
        <a href="https://www.bobothebear.io/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 sm:gap-4 hover:scale-[1.05] transition-transform duration-0 pointer-events-auto w-fit">
          <img src="/images/bobo-logo.png" alt="Bobo Logo" className="w-10 sm:w-14 md:w-20" />
          <img src="/images/bobo-logotype.png" alt="Bobo" className="h-4 sm:h-6 md:h-8" />
        </a>

        {/* High Score Badge — Desktop dropdown, mobile centered static badge */}
        {connected && (
          <>
            {/* DESKTOP ONLY: interactive dropdown in top-right */}
            <div
              className="hidden md:block absolute top-0 right-0 pointer-events-auto"
              onMouseEnter={handleTributesMouseEnter}
              onMouseLeave={handleTributesMouseLeave}
            >
              {/* Trigger button */}
              <button
                className="font-black text-sm bg-[#fee1bf] text-[#261c1a] py-2 px-4 sketch-border border-[3px] border-[#261c1a] shadow-[2px_2px_0_0_#261c1a] uppercase tracking-wide whitespace-nowrap flex items-center gap-2 hover:bg-[#6f452d] hover:text-[#fee1bf] transition-colors duration-150 cursor-pointer"
              >
                <span className="text-xl leading-none">👑</span>
                <span>Tributes: {userData?.roasts_count || 0}</span>
              </button>

              {/* Dropdown panel */}
              <div className={`tributes-dropdown absolute top-full right-0 mt-2 w-64 bg-[#6f452d] sketch-border border-[3px] border-[#261c1a] shadow-[4px_4px_0_0_#261c1a] z-50 overflow-hidden ${showLeaderboard ? 'open' : ''}`}>
                {/* Header */}
                <div className="text-[#fee1bf] px-4 py-2 flex items-center gap-2 border-b-[2px] border-[#261c1a]">
                  <span className="text-lg">👑</span>
                  <span className="font-black uppercase text-sm tracking-widest">King Board</span>
                </div>

                {/* Rows */}
                <div className="flex flex-col">
                  {leaderboard.length === 0 ? (
                    <div className="px-4 py-6 text-center font-bold text-[#fee1bf] opacity-60 text-sm uppercase">
                      No tributes yet.<br />Be the first.
                    </div>
                  ) : (
                    leaderboard.map((entry) => {
                      const medal = entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : '🥉';
                      return (
                        <div
                          key={entry.rank}
                          className="flex items-center justify-between px-4 py-3 border-b-[2px] border-[#261c1a] last:border-b-0 text-[#fee1bf]"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xl leading-none">{medal}</span>
                            <span className="font-black text-sm uppercase tracking-wide font-mono">{entry.wallet}</span>
                          </div>
                          <div className="flex flex-col items-end">
                            <span className="font-black text-lg leading-none">{entry.roasts_count}</span>
                            <span className="text-[10px] uppercase opacity-60 font-bold">roasts</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Footer */}
                <div className="bg-[#be0129] text-[#fee1bf] px-4 py-2 text-center border-t-[2px] border-[#261c1a]">
                  <span className="font-black text-xs uppercase tracking-widest">Make it go higher 📈</span>
                </div>
              </div>
            </div>

            {/* MOBILE ONLY: static centered badge, no dropdown */}
            <div className="block md:hidden absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 font-black text-xs bg-[#fee1bf] text-[#261c1a] py-1 px-2 sketch-border border-[2px] border-[#261c1a] shadow-[2px_2px_0_0_#261c1a] uppercase tracking-wide whitespace-nowrap flex items-center gap-1 pointer-events-auto">
              <span className="text-base leading-none">👑</span>
              <span>Tributes: {userData?.roasts_count || 0}</span>
            </div>
          </>
        )}
      </div>

      <div
        ref={containerRef}
        className={`w-full max-w-5xl lg:max-w-6xl sketch-border p-2 sm:p-3 md:p-5 bg-[#6f452d] text-[#fee1bf] border-[4px] border-[#261c1a] relative z-10 shadow-[8px_8px_0_0_#261c1a]${(isChatOpen && !completionTransitioned) ? ' flex flex-col h-[calc(100vh-4.5rem)] sm:h-[calc(100vh-2rem)]' : ''}`}
        style={{}}
      >
        {/* Drag handle — grab the title bar to move the window */}
        <h1
          className="text-3xl sm:text-4xl md:text-5xl leading-none font-dave-alt font-black mb-2 uppercase text-center break-words text-[#fee1bf] select-none cursor-grab active:cursor-grabbing"
          onMouseDown={onDragHandleMouseDown}
          onTouchStart={onDragHandleTouchStart}
        >
          Bobo_OS
        </h1>


        {!connected && (
          <div className="flex flex-col gap-4 text-center">
            <p className="font-bold text-lg sm:text-2xl md:text-3xl lg:text-4xl leading-tight">Connect your wallet to let Bobo analyze your worthless bags.</p>
            <div className="mt-4 flex justify-center">
              <WalletMultiButton />
            </div>
          </div>
        )}

        {connected && !userData?.point_one_verified && (
          <div className="flex flex-col gap-3 text-center items-center">
            <div className="flex flex-col justify-center items-center gap-2">
              <div className="font-bold text-sm md:text-base bg-white text-black py-1 px-3 border-2 border-black inline-block rounded">
                Connected: {publicKey?.toBase58().substring(0, 6)}...{publicKey?.toBase58().substring(38)}
              </div>
              <WalletMultiButton />
            </div>

            {/* Centered pill — same treatment as Beg for Mercy */}
            <div className="flex justify-center w-full">
              <div className="p-3 sm:p-4 sketch-border bg-[#be0129] text-[#fee1bf] border-[3px] border-[#261c1a] flex flex-col items-center justify-center gap-2 max-w-[280px] sm:max-w-sm md:max-w-md w-full">
                <span className="font-black text-base sm:text-xl md:text-2xl uppercase animate-pulse duration-0 transition-none leading-none">Bobo is analyzing...</span>
                <p className="font-bold text-xs sm:text-sm md:text-base leading-tight">Wait for the agent to verify you hold Bobo Tokens.</p>
              </div>
            </div>
          </div>
        )}

        {connected && userData?.point_one_verified && !completionTransitioned && (
          <div className={`flex flex-col gap-2 sm:gap-3${isChatOpen ? ' flex-1 overflow-hidden min-h-0' : ''}`}>
            {/* Both buttons centered and size-matched on all breakpoints */}
            <div className="flex justify-center items-center mb-1 sm:mb-2 gap-3 sm:gap-5">
              <div className="font-black text-sm bg-[#be0129] text-[#fee1bf] py-[6px] px-3 sm:py-2 sm:px-5 sketch-border uppercase tracking-wide whitespace-nowrap flex-shrink-0">
                ✓ Wallet Verified
              </div>
              <WalletMultiButton />
            </div>

            {!isChatOpen && (
              <p className="font-bold text-base sm:text-xl md:text-3xl text-center leading-tight">Bobo has acknowledged your bags. Step inside and face his judgment.</p>
            )}

            {!isChatOpen ? (
              <div className="flex justify-center w-full">
                <button
                  onClick={() => {
                    setIsChatOpen(true);
                    if (chatMessages.length === 0) {
                      const balance = userData?.token_balance || 0;
                      let initialMsg = "Hello? Who even are you lmao. You rolled in here with zero tokens. Zero. I'm not even gonna roast you — you don't deserve the energy. Go buy some $BOBO and come back when you're someone.";
                      if (balance > 0 && balance < 100) initialMsg = "Oh wow, look who showed up. Hey little guy. Those are... some bags you got there. Adorable. Listen, I don't hate you — I just feel sorry for you. You're gonna have to REALLY embarrass yourself if you want anything from me. Just so you know.";
                      else if (balance >= 100 && balance < 500) initialMsg = "Sup. You made it in. Look, I respect the move — you're not totally ngmi. But let's be real, you're not smartmoney yet either. You're in that awkward middle zone. I'm watching you. Show me something.";
                      else if (balance >= 500 && balance < 1000) initialMsg = "Hey. Yeah, I see you. And I'll be honest — you got my attention. Not many people walk in here and actually have conviction. You're close to the real tier, but close ain't there yet. I'm curious what you're gonna do with that. Impress me.";
                      else if (balance >= 1000) initialMsg = "Heyyy, look who's here. Genuinely — welcome. I don't say that to just anyone. You're actually one of us. Grab a seat, we can talk like equals for once. What's on your mind?";

                      setChatMessages([{ sender: "Bobo", text: initialMsg }]);
                    }
                  }}
                  className="bg-[#be0129] text-[#fee1bf] p-3 sm:p-4 text-base sm:text-xl md:text-2xl font-black sketch-border border-[4px] border-[#261c1a] uppercase text-center hover:bg-[#fee1bf] hover:text-[#261c1a] hover:translate-x-[4px] hover:translate-y-[4px] shadow-[4px_4px_0_0_#261c1a] transition-all duration-0 cursor-pointer max-w-[280px] sm:max-w-sm md:max-w-lg w-full"
                >
                  BEG FOR MERCY U FKN NORMIE<br />
                  <span className="text-xs sm:text-sm md:text-base font-normal lowercase block mt-1 sm:mt-2 opacity-90">(convince or bribe me... let's chat you worthless degen)</span>
                </button>
              </div>
            ) : (
              <div className="w-full bg-[#fee1bf] text-[#261c1a] border-[4px] border-[#261c1a] sketch-border flex flex-col p-3 gap-3 flex-1 min-h-0 overflow-hidden">
                <div className="flex justify-between items-center flex-shrink-0 px-1 pb-1">
                  <span className="font-black uppercase text-[#261c1a] text-xl sm:text-2xl">Chat with Bobo</span>
                  <button
                    onClick={() => setIsChatOpen(false)}
                    className="chat-close-btn"
                    aria-label="Close chat"
                  />
                </div>

                {/*
                  KEY FIX: Split into two divs.
                  Outer: owns the border + border-radius + overflow:hidden → clips the
                         scrollbar so it never bleeds outside the rounded box.
                  Inner: pure scroll container, no border/radius of its own.
                */}
                <div
                  className="flex-1 min-h-0 border-[3px] border-[#261c1a] overflow-hidden"
                  style={{
                    borderRadius: '15px 225px 15px 255px / 255px 15px 225px 15px',
                    boxShadow: 'inset 4px 4px 14px rgba(38,28,26,0.18), inset -2px -2px 8px rgba(38,28,26,0.08)'
                  }}
                >
                  <div ref={chatScrollRef} className="custom-scroll custom-scroll-firefox h-full overflow-y-auto p-4 flex flex-col gap-3">
                    {chatMessages.length === 0 && <p className="text-lg font-bold opacity-60 text-center mt-6">Go ahead, whine about your bags.</p>}
                    {chatMessages.map((m, i) => (
                      <div key={i} className={`p-3 border-[2px] border-[#261c1a] max-w-[80%] rounded-[15px] ${m.sender === 'Bobo' ? 'bg-[#be0129] text-[#fee1bf] self-start' : 'bg-[#6f452d] text-[#fee1bf] self-end'}`}>
                        <span className="font-black text-sm lg:text-lg block uppercase text-[#fee1bf]">{m.sender}:</span>
                        <span className="font-bold text-base md:text-lg lg:text-2xl block break-words text-[#fee1bf] leading-snug whitespace-pre-wrap">{m.text}</span>
                        {m.image && (
                          <div className="mt-2 flex items-center justify-center">
                            <img
                              src={m.image}
                              alt="Bobo Celebration"
                              className="rounded-xl max-w-full max-h-[320px] object-contain border-2 border-transparent"
                              onLoad={() => {
                                setTimeout(() => {
                                  if (chatScrollRef.current) {
                                    chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
                                  }
                                }, 50);
                              }}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                    {/* Meme bubble shown while Bobo is thinking */}
                    {isTyping && typingMeme && (
                      <div className="p-2 border-[2px] border-[#261c1a] max-w-[72%] rounded-[15px] bg-[#be0129] self-start overflow-hidden flex flex-col min-w-[200px] min-h-[160px]">
                        <span className="font-black text-xs block uppercase text-[#fee1bf] mb-1 px-1">Bobo:</span>
                        <div className="flex-1 flex items-center justify-center">
                          <img
                            src={typingMeme}
                            alt="Bobo is thinking..."
                            className="rounded-xl w-full max-h-52 object-contain"
                            onLoad={() => {
                              setTimeout(() => {
                                if (chatScrollRef.current) {
                                  chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
                                }
                              }, 50);
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex gap-2 flex-shrink-0">
                  <input
                    className={`flex-1 border-[3px] border-[#261c1a] rounded-lg px-3 py-2 font-bold focus:outline-none min-w-0 text-base bg-[#fee1bf] text-[#261c1a] transition-opacity${isTyping ? ' opacity-40 cursor-not-allowed' : ''}`}
                    style={{ boxShadow: 'inset 3px 3px 8px rgba(38,28,26,0.15), inset -1px -1px 5px rgba(38,28,26,0.07)' }}
                    type="text"
                    placeholder={isTyping ? "Waiting for Bobo..." : "I lost everything..."}
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !isTyping && handleChatSubmit()}
                    disabled={isTyping}
                  />
                  <button
                    className={`font-black uppercase px-6 border-[3px] border-[#261c1a] rounded-lg text-lg transition-all duration-0 bg-[#be0129] text-[#fee1bf]${isTyping ? ' opacity-40 cursor-not-allowed' : ' hover:bg-[#6f452d] cursor-pointer'}`}
                    onClick={handleChatSubmit}
                    disabled={isTyping}
                  >
                    Send
                  </button>
                </div>
              </div>
            )}

            {!isChatOpen && (
              <p className="font-bold text-xl text-center mt-2 animate-pulse duration-0">Polling for state changes...</p>
            )}
          </div>
        )}

        {connected && userData && completionTransitioned && !userData.roast_published && (
          <div className="flex flex-col gap-6 items-center w-full">
            <div className="flex w-full justify-end">
              <WalletMultiButton />
            </div>
            <p className="font-black text-4xl md:text-5xl uppercase underline decoration-4 underline-offset-8 text-[#fee1bf] text-center leading-tight mt-4">BOBO IS SATISFIED.</p>

            <button
              className="w-full bg-[#be0129] text-[#fee1bf] border-[4px] border-[#261c1a] shadow-[4px_4px_0_0_#261c1a] p-8 mt-6 text-6xl font-black sketch-border hover:bg-[#fee1bf] hover:text-[#261c1a] hover:translate-x-[4px] hover:translate-y-[4px] transition-all duration-0 uppercase text-center cursor-pointer"
              onClick={() => window.open('https://x.com/bobo__os', '_blank')}
            >
              Dump It
            </button>
          </div>
        )}

        {connected && userData?.roast_published && (
          <div className="w-full p-8 border-[4px] border-[#261c1a] shadow-[4px_4px_0_0_#261c1a] bg-[#fee1bf] text-[#261c1a] rounded-[15px_225px_15px_255px/255px_15px_225px_15px] flex flex-col items-center justify-center gap-6">
            <p className="font-black text-6xl uppercase text-center text-[#be0129]">WALLET ROASTED</p>
            <p className="font-bold text-center text-3xl md:text-4xl leading-tight">Your on-chain embarrassment is now public.</p>

            <div className="bg-[#6f452d] text-[#fee1bf] p-4 w-full max-w-md border-[3px] border-[#261c1a] sketch-border flex flex-col items-center gap-2 mt-4">
              <span className="font-black text-2xl uppercase">Total Tributes: {userData?.roasts_count || 1}</span>
              <p className="text-center font-bold text-lg opacity-90">Bobo is resting. Come back in:</p>
              <span className="font-black text-4xl text-[#be0129] bg-[#fee1bf] px-4 py-2 sketch-border border-2 border-[#261c1a]">
                {cooldownTimeLeft || "calculating..."}
              </span>
              <p className="text-sm opacity-70 mt-2 font-bold uppercase">To get roasted again</p>
            </div>

            <div className="mt-4">
              <WalletMultiButton />
            </div>
          </div>
        )}
      </div>

    </main>
  );
}

