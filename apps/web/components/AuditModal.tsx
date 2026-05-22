"use client";

import React, { useState, useEffect, useRef } from "react";
import { X, Download, Share2, Loader2 } from "lucide-react";
import { getWalletDeGeneracyStats, getMemeBase64 } from "../app/actions";

interface AuditModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
}

export default function AuditModal({ isOpen, onClose, walletAddress }: AuditModalProps) {
  const [loading, setLoading] = useState(true);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [base64Meme, setBase64Meme] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Fetch stats when walletAddress changes or modal opens
  useEffect(() => {
    if (!isOpen || !walletAddress) return;

    let active = true;
    setLoading(true);
    setBase64Meme(null);

    async function loadStats() {
      try {
        const res = await getWalletDeGeneracyStats(walletAddress);
        if (!active) return;

        if (res.success && res.memeUrl) {
          setStats(res);
          // Pre-fetch image as base64 to prevent canvas taint
          const base64 = await getMemeBase64(res.memeUrl);
          if (active) {
            setBase64Meme(base64);
            setLoading(false);

            // Open pump.fun tabs for any missing tokens (short delay so modal renders first)
            setTimeout(() => {
              if (!res.holdsAgent) {
                window.open(
                  "https://pump.fun/coin/BywoEP4ch5EWb7okZ7wqKuwpnSKr5uuhbzo98XRgpump",
                  "_blank",
                  "noopener,noreferrer"
                );
              }
              if (!res.holdsBobo) {
                window.open(
                  "https://pump.fun/coin/4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump",
                  "_blank",
                  "noopener,noreferrer"
                );
              }
            }, 800);
          }
        } else {
          setLoading(false);
        }
      } catch (err) {
        console.error("Failed to load degeneracy stats:", err);
        if (active) setLoading(false);
      }
    }

    loadStats();

    return () => {
      active = false;
    };
  }, [isOpen, walletAddress]);

  if (!isOpen) return null;

  const truncateWallet = (w: string) => {
    if (!w || w.length <= 10) return w;
    return `${w.slice(0, 6)}...${w.slice(-6)}`;
  };

  const drawReportCard = async (): Promise<HTMLCanvasElement | null> => {
    if (!stats || !base64Meme) return null;
    await document.fonts.ready;

    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // 1. Background
    ctx.fillStyle = "#fee1bf"; // Peach background
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Helper function for hand-drawn wavy lines
    const drawWavyLine = (x1: number, y1: number, x2: number, y2: number, width = 3, color = "#261c1a") => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      const midX = (x1 + x2) / 2 + (Math.random() - 0.5) * 6;
      const midY = (y1 + y2) / 2 + (Math.random() - 0.5) * 6;
      ctx.quadraticCurveTo(midX, midY, x2, y2);
      ctx.stroke();
    };

    // Helper to draw a sketch box
    const drawSketchBox = (x: number, y: number, w: number, h: number, width = 3, color = "#261c1a") => {
      drawWavyLine(x, y, x + w, y, width, color);
      drawWavyLine(x + w, y, x + w, y + h, width, color);
      drawWavyLine(x + w, y + h, x, y + h, width, color);
      drawWavyLine(x, y + h, x, y, width, color);
    };

    // 2. Double border sketch frame
    drawSketchBox(15, 15, canvas.width - 30, canvas.height - 30, 4);
    drawSketchBox(22, 22, canvas.width - 44, canvas.height - 44, 1.5, "#6f452d");

    // 3. Header Text
    ctx.fillStyle = "#261c1a";
    ctx.textAlign = "center";
    
    // Title: "ON-CHAIN DEGENERACY REPORT" (+ crown if OG)
    ctx.font = "bold 38px 'Ugly Dave', sans-serif";
    const titleText = stats.isOG
      ? "\uD83D\uDC51 ON-CHAIN DEGENERACY REPORT \uD83D\uDC51"
      : "ON-CHAIN DEGENERACY REPORT";
    ctx.fillText(titleText, canvas.width / 2, 75);

    // Student Wallet Subtitle
    ctx.font = "normal 18px 'Oswald', sans-serif";
    ctx.fillStyle = "#6f452d";
    ctx.fillText(`STUDENT WALLET: ${walletAddress}`, canvas.width / 2, 105);

    // Divider line
    drawWavyLine(40, 125, canvas.width - 40, 125, 2, "#261c1a");

    // 4. Draw Meme Image (Left Column)
    const imgX = 50;
    const imgY = 160;
    const imgW = 280;
    const imgH = 280;

    // Draw shadow box behind image
    ctx.fillStyle = "rgba(38, 28, 26, 0.15)";
    ctx.fillRect(imgX + 8, imgY + 8, imgW, imgH);

    // Draw white image background card
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(imgX, imgY, imgW, imgH);
    drawSketchBox(imgX, imgY, imgW, imgH, 3);

    // Draw the image
    const img = new Image();
    img.src = base64Meme;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => {
        ctx.drawImage(img, imgX + 10, imgY + 10, imgW - 20, imgH - 20);
        resolve();
      };
      img.onerror = () => {
        reject(new Error("Failed to load meme image onto canvas"));
      };
    });

    // Label below image
    ctx.fillStyle = "#261c1a";
    ctx.font = "italic 16px 'Ugly Dave', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`Meme Grade: ${stats.grade}`, imgX + imgW / 2, imgY + imgH + 28);

    // 5. Stats list (Right Column)
    const statsX = 380;
    const startStatsY = 180;
    const rowGap = 34;

    ctx.textAlign = "left";
    ctx.fillStyle = "#261c1a";

    const items = [
      { label: "GAS SPENT:", value: `${stats.stats.gasSpent} SOL` },
      { label: "JEET INDEX (QUICK SWAPS):", value: `${stats.stats.jeetIndex}` },
      { label: "RUGS TOUCHED:", value: `${stats.stats.rugsTouched}` },
      { label: "WIN RATE:", value: `${stats.stats.winRate}%` },
      { label: "LIFETIME TRADES:", value: `${stats.stats.lifetimeTrades}` },
    ];

    items.forEach((item, index) => {
      const itemY = startStatsY + index * rowGap;
      
      // Label (Oswald Font)
      ctx.font = "bold 15px 'Oswald', sans-serif";
      ctx.fillStyle = "#6f452d";
      ctx.fillText(item.label, statsX, itemY);

      // Value (Oswald Font, aligned right)
      ctx.font = "bold 20px 'Oswald', sans-serif";
      ctx.fillStyle = "#be0129";
      ctx.fillText(item.value, statsX + 220, itemY);
    });

    // 6. Draw Overall Stamp Circle
    const stampX = 690;
    const stampY = 250;
    const radius = 60;

    // Draw stamp circle lines
    ctx.strokeStyle = "#be0129";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(stampX, stampY, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(stampX, stampY, radius - 6, 0, Math.PI * 2);
    ctx.stroke();

    // Stamp Text: "DEGEN GRADE"
    ctx.save();
    ctx.fillStyle = "#be0129";
    ctx.font = "bold 9px 'Oswald', sans-serif";
    ctx.textAlign = "center";
    ctx.translate(stampX, stampY - 38);
    ctx.fillText("DEGEN GRADE", 0, 0);
    ctx.restore();

    // Stamp Grade Letter (Huge Ugly Dave font)
    ctx.fillStyle = "#be0129";
    ctx.font = "bold 70px 'Ugly Dave', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(stats.grade, stampX, stampY + 22);

    // Rotate stamp slightly for a messy realistic look
    // (We already drew it, but we can draw some extra lines/scratches)
    ctx.strokeStyle = "rgba(190, 1, 41, 0.4)";
    ctx.lineWidth = 2;
    drawWavyLine(stampX - radius - 10, stampY + 10, stampX + radius + 10, stampY - 15, 2, "rgba(190, 1, 41, 0.3)");

    // 7. Remarks / Roast Box (Bottom)
    const remarkX = 50;
    const remarkY = 475;
    const remarkW = canvas.width - 100;
    const remarkH = 90;

    ctx.fillStyle = "rgba(111, 69, 45, 0.05)";
    ctx.fillRect(remarkX, remarkY, remarkW, remarkH);
    drawSketchBox(remarkX, remarkY, remarkW, remarkH, 2, "#6f452d");

    // "REMARKS:" heading
    ctx.fillStyle = "#6f452d";
    ctx.font = "bold 14px 'Oswald', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("TEACHER REMARKS:", remarkX + 15, remarkY + 28);

    // Roast content (Ugly Dave Alternates font)
    ctx.fillStyle = "#261c1a";
    ctx.font = "normal 18px 'Ugly Dave Alternates', sans-serif";
    
    // Simple multi-line text wrapping helper
    const words = stats.description.split(" ");
    let line = "";
    let lineY = remarkY + 54;
    const maxLineWidth = remarkW - 30;

    for (let i = 0; i < words.length; i++) {
      const testLine = line + words[i] + " ";
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxLineWidth && i > 0) {
        ctx.fillText(line, remarkX + 15, lineY);
        line = words[i] + " ";
        lineY += 24;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line, remarkX + 15, lineY);

    return canvas;
  };

  const handleDownload = async () => {
    if (!stats || !base64Meme) return;
    setGeneratingImage(true);

    try {
      const canvas = await drawReportCard();
      if (!canvas) return;

      // Trigger download
      const dataUrl = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.download = `bobo_degeneracy_report_${walletAddress.slice(0, 8)}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error("Error drawing report card:", err);
      alert("Failed to render scorecard image. Please try again.");
    } finally {
      setGeneratingImage(false);
    }
  };

  const handleShare = async () => {
    if (!stats || !base64Meme) return;
    setGeneratingImage(true);

    try {
      const canvas = await drawReportCard();
      if (!canvas) {
        setGeneratingImage(false);
        return;
      }

      // Wrap toBlob in a promise to avoid nested callbacks and keep async execution clean
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), "image/png");
      });

      if (!blob) {
        setGeneratingImage(false);
        return;
      }

      const file = new File([blob], "bobo_report_card.png", { type: "image/png" });

      // Detect mobile device
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
                       (navigator.maxTouchPoints && navigator.maxTouchPoints > 2 && /Macintosh/.test(navigator.userAgent));

      // 1. Try Web Share API (native mobile share dialog) ONLY on mobile
      if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            text: "@bobo__labs",
          });
          setGeneratingImage(false);
          return;
        } catch (shareErr) {
          console.log("Web share failed/cancelled, trying clipboard fallback:", shareErr);
        }
      }

      // 2. Clipboard Fallback (Desktop or unsupported mobile browser)
      let copied = false;
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": blob })
          ]);
          copied = true;
        }
      } catch (clipErr) {
        console.error("Failed to copy image to clipboard:", clipErr);
      }

      // 3. Open X with the tag
      const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent("@bobo__labs")}`;
      const newWindow = window.open(shareUrl, "_blank");

      if (copied) {
        alert("Scorecard image copied to clipboard! Paste it directly (Ctrl+V / Cmd+V) into your tweet.");
      } else {
        if (!newWindow) {
          alert("Popup blocker blocked opening X. Please enable popups or go to twitter.com manually!");
        } else {
          alert("Could not automatically copy the scorecard to clipboard. Please download the card first, then upload it on X!");
        }
      }
    } catch (err) {
      console.error("Error sharing report card:", err);
      alert("Failed to share report card. Try downloading it first.");
    } finally {
      setGeneratingImage(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      {/* Modal Container */}
      <div 
        className="relative w-full max-w-2xl bg-[#fee1bf] text-[#261c1a] border-4 border-[#261c1a] p-6 md:p-8 overflow-y-auto max-h-[90vh] custom-scroll"
        style={{
          borderRadius: "20px 8px 24px 8px/8px 24px 8px 20px",
          boxShadow: "8px 8px 0px 0px #261c1a"
        }}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 flex items-center justify-center w-8 h-8 rounded-full border-2 border-[#261c1a] hover:bg-[#be0129] hover:text-[#fee1bf] transition-colors cursor-pointer"
          style={{ transform: "rotate(-3deg)" }}
        >
          <X className="w-5 h-5" />
        </button>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 space-y-4">
            <Loader2 className="w-12 h-12 animate-spin text-[#be0129]" />
            <h3 className="font-dave-alt text-2xl animate-pulse text-center">
              SCRUTINIZING YOUR TRASH TRANSACTIONS...
            </h3>
            <p className="font-oswald text-sm text-[#6f452d] tracking-wide">
              (Estimating gas spent & counting rug pulls)
            </p>
          </div>
        ) : (
          <div className="flex flex-col space-y-6">
            {/* Header */}
            <div className="text-center pb-2 border-b-2 border-dashed border-[#261c1a]/30">
              <h2 className="font-dave text-3xl md:text-4xl text-[#be0129] tracking-wider">
                {stats.isOG && <span className="mr-2">👑</span>}
                DEGENERACY REPORT CARD
                {stats.isOG && <span className="ml-2">👑</span>}
              </h2>
              <p className="font-oswald text-xs md:text-sm text-[#6f452d] uppercase tracking-wider mt-1">
                STUDENT: <span className="text-[#261c1a]">{truncateWallet(walletAddress)}</span>
              </p>
              {stats.isOG && (
                <p className="font-oswald text-xs text-amber-600 font-bold tracking-widest mt-1 uppercase">
                  ✦ OG Holder — $AGENT &amp; $BOBO Verified ✦
                </p>
              )}
              {(!stats.holdsAgent || !stats.holdsBobo) && (
                <p className="font-oswald text-xs text-[#be0129] font-bold tracking-wide mt-1">
                  ⚠ Opening pump.fun for missing token{!stats.holdsAgent && !stats.holdsBobo ? "s" : ""}...
                </p>
              )}
            </div>

            {/* Scorecard Body */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
              {/* Left Column: Meme Asset */}
              <div className="flex flex-col items-center space-y-2">
                <div 
                  className="bg-white p-3 border-3 border-[#261c1a] shadow-md flex items-center justify-center max-w-[240px] w-full"
                  style={{
                    borderRadius: "12px 12px 12px 12px/4px 12px 4px 12px",
                  }}
                >
                  {base64Meme ? (
                    <img 
                      src={base64Meme} 
                      alt="Bobo Grade Asset" 
                      className="w-full h-auto object-contain border-2 border-[#261c1a]/10" 
                    />
                  ) : (
                    <div className="w-[180px] h-[180px] bg-neutral-100 flex items-center justify-center text-xs text-neutral-400 font-mono">
                      Image Loading...
                    </div>
                  )}
                </div>
                <span className="font-dave-alt text-lg italic text-[#6f452d]">
                  Grade: {stats.grade}
                </span>
              </div>

              {/* Right Column: Key Stats & Stamp */}
              <div className="relative flex flex-col space-y-4">
                {/* Stamp */}
                <div 
                  className="absolute right-0 top-[-20px] md:top-[-40px] flex flex-col items-center justify-center border-4 border-double border-[#be0129] text-[#be0129] rounded-full w-24 h-24 rotate-[12deg] z-10"
                  style={{
                    boxShadow: "0 0 0 2px #be0129"
                  }}
                >
                  <span className="font-oswald text-[9px] font-bold tracking-widest leading-none">GRADE</span>
                  <span className="font-dave text-4xl md:text-5xl leading-none mt-1">{stats.grade}</span>
                </div>

                {/* Stats list */}
                <div className="flex flex-col space-y-3 font-oswald text-base">
                  <div className="flex justify-between border-b border-[#261c1a]/15 pb-1">
                    <span className="text-[#6f452d] font-bold uppercase">Gas Donated:</span>
                    <span className="text-[#be0129] font-black">{stats.stats.gasSpent} SOL</span>
                  </div>
                  <div className="flex justify-between border-b border-[#261c1a]/15 pb-1">
                    <span className="text-[#6f452d] font-bold uppercase">Jeet Index:</span>
                    <span className="text-[#be0129] font-black">{stats.stats.jeetIndex} swaps</span>
                  </div>
                  <div className="flex justify-between border-b border-[#261c1a]/15 pb-1">
                    <span className="text-[#6f452d] font-bold uppercase">Rugs Touched:</span>
                    <span className="text-[#be0129] font-black">{stats.stats.rugsTouched} tokens</span>
                  </div>
                  <div className="flex justify-between border-b border-[#261c1a]/15 pb-1">
                    <span className="text-[#6f452d] font-bold uppercase">Win Rate:</span>
                    <span className="text-[#be0129] font-black">{stats.stats.winRate}%</span>
                  </div>
                  <div className="flex justify-between border-b border-[#261c1a]/15 pb-1">
                    <span className="text-[#6f452d] font-bold uppercase">Total Trades:</span>
                    <span className="text-[#be0129] font-black">{stats.stats.lifetimeTrades}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Remarks / Roast Box */}
            <div 
              className="bg-[#6f452d]/5 p-4 border-2 border-[#6f452d]/50"
              style={{
                borderRadius: "15px 4px 15px 4px/4px 15px 4px 15px",
              }}
            >
              <h4 className="font-oswald text-xs font-bold text-[#6f452d] tracking-wider uppercase mb-1">
                TEACHER REMARKS:
              </h4>
              <p className="font-dave-alt text-xl md:text-2xl text-[#261c1a] leading-relaxed">
                "{stats.description}"
              </p>
            </div>

            {/* Footer Actions */}
            <div className="flex flex-col sm:flex-row gap-4 pt-2">
              <button
                onClick={handleDownload}
                disabled={generatingImage}
                className="flex-1 flex items-center justify-center gap-2 font-dave text-xl md:text-2xl bg-[#be0129] hover:bg-[#be0129]/90 text-[#fee1bf] border-3 border-[#261c1a] py-2.5 px-4 shadow-[4px_4px_0px_0px_#261c1a] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0px_0px_#261c1a] disabled:opacity-50 transition-all cursor-pointer"
                style={{
                  borderRadius: "255px 15px 225px 15px/15px 225px 15px 255px",
                }}
              >
                {generatingImage ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    GENERATING CARD...
                  </>
                ) : (
                  <>
                    <Download className="w-5 h-5" />
                    DOWNLOAD REPORT CARD
                  </>
                )}
              </button>
              
              <button
                onClick={handleShare}
                disabled={generatingImage}
                className="flex-1 flex items-center justify-center gap-2 font-dave text-xl md:text-2xl bg-[#261c1a] hover:bg-[#261c1a]/90 text-[#fee1bf] border-3 border-[#261c1a] py-2.5 px-4 shadow-[4px_4px_0px_0px_#6f452d] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0px_0px_#6f452d] disabled:opacity-50 transition-all cursor-pointer"
                style={{
                  borderRadius: "15px 255px 15px 225px/225px 15px 255px 15px",
                }}
              >
                {generatingImage ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    GENERATING CARD...
                  </>
                ) : (
                  <>
                    <Share2 className="w-5 h-5" />
                    Share on X
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
