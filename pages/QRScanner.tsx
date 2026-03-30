import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Html5Qrcode } from 'html5-qrcode';
import { ArrowLeft, Camera, QrCode, X, Info, Zap, Radio, Waves, AlertCircle, Smartphone, CheckCircle2, Wallet } from 'lucide-react';

const QRScanner: React.FC = () => {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [isFlashOn, setIsFlashOn] = useState(false);
  const [scanResult, setScanResult] = useState<{ pa: string, pn: string, am?: string, platform?: string, type: 'upi' | 'stellar' } | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [isScannerInitialized, setIsScannerInitialized] = useState(false);
  const [universalChoice, setUniversalChoice] = useState<{
    type: 'ETH' | 'STELLAR';
    address: string;
    amount: string;
    memo?: string;
    rawUri?: string;
  } | null>(null);

  const initiateCrossChainPayment = (ethAddress: string, amount: string) => {
    // Placeholder for future swap provider integration (e.g., Allbridge or Stellar Bridge)
    console.log(`Initiating Cross-Chain Payment to ${ethAddress} for ${amount} ETH equivalent`);

    // Redirect to a specialized send screen or a bridge UI
    // Here we use the existing send screen with a special flag
    navigate(`/send?to=${ethAddress}&amt=${amount}&mode=ethereum&network=mainnet`);
  };

  useEffect(() => {
    let isMounted = true;

    const stopScanner = async () => {
      if (scannerRef.current && scannerRef.current.isScanning) {
        try {
          await scannerRef.current.stop();
          console.log("Scanner stopped successfully");
        } catch (err) {
          console.error("Scanner stop failed", err);
        }
      }
    };

    async function onScanSuccess(decodedText: string) {
      if (!isMounted) return;
      console.log("Scan successful:", decodedText);

      // Stop camera immediately on success to release it
      await stopScanner();

      // 0. Handled by generic URL parser below (Step 5)

      // 1. Handle MetaMask QR / Ethereum URI
      if (decodedText.startsWith('ethereum:')) {
        try {
          const uri = decodedText.replace('ethereum:', 'https://eth.host/');
          const url = new URL(uri);
          const ethAddress = url.pathname.slice(1);
          const amount = url.searchParams.get('value') || '';

          setUniversalChoice({
            type: 'ETH',
            address: ethAddress,
            amount: amount,
            rawUri: decodedText
          });
          return;
        } catch (e) {
          console.error("Ethereum URI Parse Error", e);
        }
      }

      // 1. Handle plain Stellar address
      if (decodedText.length === 56 && (decodedText.startsWith('G') || decodedText.startsWith('S'))) {
        navigate(`/send?to=${decodedText}`);
        return;
      }

      // 2. Handle Stellar URL format (stellar.sep7 / Freighter compatible)
      if (decodedText.startsWith('web+stellar:pay') || decodedText.startsWith('stellar:pay')) {
        try {
          const rawUrl = decodedText.startsWith('web+stellar:')
            ? decodedText.replace('web+stellar:', 'https:')
            : decodedText.replace('stellar:', 'https:');
          const url = new URL(rawUrl);
          const destination = url.searchParams.get('destination') || url.pathname.slice(1);
          const amount = url.searchParams.get('amount') || '';
          const memo = url.searchParams.get('memo') || url.searchParams.get('note') || '';

          // Directly navigate to send screen for Stellar Native experience
          navigate(`/send?to=${destination}&amt=${amount}&note=${memo}`);
          return;
        } catch (e) {
          console.error("Stellar SEP7 Parse Error:", e);
        }
      }

      // 3. Handle UPI
      if (decodedText.startsWith('upi://pay')) {
        try {
          const url = new URL(decodedText);
          const pa = url.searchParams.get('pa') || '';
          const pn = url.searchParams.get('pn') || '';
          const am = url.searchParams.get('am') || '';

          navigate(`/send?to=${pa}&amt=${am}&pn=${pn}&mode=upi`);
          return;
        } catch (e) {
          console.error("UPI Parse Error", e);
        }
      }

      // 4. Handle Federation / Email-style Stellar ID
      if (decodedText.includes('@') && !decodedText.includes('://')) {
        navigate(`/send?to=${decodedText}`);
        return;
      }

      // 5. Handle the app's own hash-routed URLs (Standardized)
      try {
        const url = new URL(decodedText);
        const hash = url.hash; // e.g. "#/pay/user@stellar"
        const pathToCheck = hash ? hash.slice(1) : url.pathname;

        if (pathToCheck && pathToCheck !== '/') {
          // Standardize: ensure it starts with /
          const normalizedPath = pathToCheck.startsWith('/') ? pathToCheck : '/' + pathToCheck;

          // INTERCEPT: If it's a payment link, navigate to internal "Send" screen instead of the web gateway
          if (normalizedPath.startsWith('/pay/')) {
            const recipientId = normalizedPath.split('/pay/')[1];
            const searchParams = new URLSearchParams(url.search);
            const amt = searchParams.get('amt') || '';
            const note = searchParams.get('note') || '';
            navigate(`/send?to=${recipientId}&amt=${amt}&note=${note}`);
            return;
          }

          // Check for other known routes
          if (
            normalizedPath.startsWith('/link/') ||
            normalizedPath.startsWith('/claim') ||
            normalizedPath.startsWith('/send') ||
            normalizedPath.startsWith('/subscribe/')
          ) {
            navigate(normalizedPath + url.search);
            return;
          }
        }

        // Fallback: check searchParams on non-matched URLs
        const to = url.searchParams.get('to');
        const planId = url.searchParams.get('planId');
        const amt = url.searchParams.get('amt') || '';
        const note = url.searchParams.get('note') || '';

        if (planId) {
          navigate(`/subscribe/${planId}`);
        } else if (to) {
          navigate(`/send?to=${to}&amt=${amt}&note=${note}`);
        } else {
          throw new Error("No route match");
        }
      } catch (e) {
        // Final fallback: raw Stellar public key
        if (decodedText.includes('G') && decodedText.length > 50) {
          const match = decodedText.match(/G[A-Z0-9]{55}/);
          if (match) {
            navigate(`/send?to=${match[0]}`);
            return;
          }
        }

        setError("Invalid QR Code");
        setTimeout(() => {
          if (isMounted) {
            setError('');
            startScanner();
          }
        }, 3000);
      }
    }

    function onScanFailure(error: any) {
      // Noise - don't log every failure frame
    }

    const startScanner = async () => {
      // Small delay to ensure the DOM element "reader" is ready
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!isMounted) return;

      const html5QrCode = new Html5Qrcode("reader");
      scannerRef.current = html5QrCode;

      const config = {
        fps: 15,
        qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
          const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
          const qrboxSize = Math.max(150, Math.floor(minEdge * 0.7));
          return { width: qrboxSize, height: qrboxSize };
        },
        aspectRatio: 1.0,
      };

      try {
        await html5QrCode.start(
          { facingMode: "environment" },
          config,
          onScanSuccess,
          onScanFailure
        );
        if (isMounted) setIsScannerInitialized(true);
      } catch (err) {
        console.error("Scanner start failed", err);
        if (isMounted) setError("Camera access denied or device not found");
      }
    };

    startScanner();

    return () => {
      isMounted = false;
      stopScanner();
    };
  }, [navigate]);

  const toggleFlash = async () => {
    if (!scannerRef.current || !isScannerInitialized) return;
    try {
      const newFlashState = !isFlashOn;
      // Note: torch control through applyVideoConstraints is only supported on some browsers/devices
      await scannerRef.current.applyVideoConstraints({
        // @ts-ignore
        advanced: [{ torch: newFlashState }]
      });
      setIsFlashOn(newFlashState);
    } catch (err) {
      console.warn("Flash toggle failed - likely not supported on this device/browser", err);
    }
  };

  const handleClose = async () => {
    if (scannerRef.current && scannerRef.current.isScanning) {
      try {
        await scannerRef.current.stop();
      } catch (e) {
        console.error("Stop failed during close", e);
      }
    }
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-black text-white flex flex-col relative overflow-hidden font-sans">
      {/* Immersive Backdrop */}
      <div className="absolute inset-0 bg-black z-0"></div>

      {/* Top Header - Native Style */}
      <div className="relative z-20 pt-14 px-6 flex items-center justify-between">
        <button
          onClick={handleClose}
          className="w-12 h-12 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-xl border border-white/10 active:scale-95 transition-all"
        >
          <ArrowLeft size={22} className="text-white" />
        </button>
        <div className="flex flex-col items-center">
          <span className="text-[10px] font-black uppercase tracking-[0.4em] text-zinc-500 mb-1">Scanner</span>
          <div className="flex items-center gap-1.5 px-3 py-1 bg-[#E5D5B3]/10 border border-[#E5D5B3]/20 rounded-full">
            <div className={`w-1 h-1 bg-[#E5D5B3] rounded-full shadow-[0_0_8px_rgba(229,213,179,0.5)] ${isScannerInitialized ? 'animate-pulse' : 'opacity-20'}`}></div>
            <span className="text-[9px] font-black uppercase tracking-widest text-[#E5D5B3]">
              {isScannerInitialized ? 'Active' : 'Initializing'}
            </span>
          </div>
        </div>
        <button
          onClick={handleClose}
          className="w-12 h-12 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-xl border border-white/10 active:scale-95 transition-all"
        >
          <X size={22} className="text-white" />
        </button>
      </div>

      {/* Main Scanner Section */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center ">
        <div className="relative w-full aspect-square max-w-[320px]">
          {/* Scanning Corners - Sleeker */}
          <div className="absolute -top-1 -left-1 w-12 h-12 border-t-[3px] border-l-[3px] border-[#E5D5B3] rounded-tl-3xl z-30"></div>
          <div className="absolute -top-1 -right-1 w-12 h-12 border-t-[3px] border-r-[3px] border-[#E5D5B3] rounded-tr-3xl z-30"></div>
          <div className="absolute -bottom-1 -left-1 w-12 h-12 border-b-[3px] border-l-[3px] border-[#E5D5B3] rounded-bl-3xl z-30"></div>
          <div className="absolute -bottom-1 -right-1 w-12 h-12 border-b-[3px] border-r-[3px] border-[#E5D5B3] rounded-br-3xl z-30"></div>

          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#E5D5B3] to-transparent shadow-[0_0_20px_rgba(229,213,179,0.8)] z-40 animate-scan-slow opacity-60"></div>
          {/* Scanner Window */}
          <div className="relative w-full h-full bg-zinc-950 rounded-[.5rem] overflow-hidden border border-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)] z-10 group">
            <div id="reader" className="w-full h-full"></div>
          </div>

          {/* Error Message Tooltip */}
          {error && (
            <div className="absolute -bottom-24 left-1/2 -translate-x-1/2 w-max max-w-[280px] px-6 py-4 bg-rose-500 text-white rounded-2xl font-bold text-xs shadow-2xl z-50 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <AlertCircle size={18} />
              {error}
            </div>
          )}
        </div>

        {/* Scan Result Bottom Drawer - UPI ONLY */}
        {scanResult && scanResult.type === 'upi' && (
          <div className="fixed inset-0 z-[100] flex items-end justify-center">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-xl" onClick={() => setScanResult(null)}></div>

            <div className="relative w-full max-w-md bg-zinc-950 rounded-t-[3rem] overflow-hidden shadow-[0_-20px_100px_rgba(0,0,0,0.8)] animate-in slide-in-from-bottom duration-500 border-t border-white/10">
              {/* Handle */}
              <div className="flex justify-center pt-4 pb-2">
                <div className="w-12 h-1.5 bg-white/10 rounded-full"></div>
              </div>

              {/* Theme Aligned Header */}
              <div className="relative h-24 flex flex-col items-center justify-center overflow-hidden border-b border-white/5 bg-zinc-900/50">
                <div className="absolute inset-0 bg-gradient-to-b from-[#E5D5B3]/5 to-transparent"></div>
                <div className="relative z-10 flex flex-col items-center">
                  <div className="w-12 h-12 bg-zinc-950 border border-[#E5D5B3]/20 rounded-2xl flex items-center justify-center mb-2 shadow-2xl">
                    <Smartphone size={24} className="text-[#E5D5B3]/80" />
                  </div>
                  <span className="text-[10px] font-black uppercase tracking-[0.5em] text-[#E5D5B3]/40">
                    UPI Node Found
                  </span>
                </div>
              </div>

              <div className="px-8 pt-8 pb-12">
                {/* Identity Card */}
                <div className="relative mb-8 text-center">
                  <div className="inline-flex items-center gap-2 px-3 py-1 bg-white/5 border border-white/10 rounded-full mb-4">
                    <div className="w-1.5 h-1.5 bg-[#E5D5B3] rounded-full animate-pulse shadow-[0_0_8px_rgba(229,213,179,0.5)]"></div>
                    <span className="text-[9px] font-black uppercase tracking-widest text-[#E5D5B3]/80">
                      Detected VPA
                    </span>
                  </div>

                  <h3 className="text-3xl font-black tracking-tighter text-white mb-2 leading-none">
                    {scanResult.pn || "Merchant Node"}
                  </h3>

                  <div className="flex flex-col items-center gap-3">
                    <div className="px-3 py-1 bg-white/5 border border-white/10 rounded-lg">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">
                        Platform: <span className="text-white">{scanResult.platform}</span>
                      </span>
                    </div>
                    <p className="text-zinc-500 font-mono text-xs tracking-tight break-all max-w-[280px] bg-black/40 px-3 py-2 rounded-xl border border-white/5">
                      {scanResult.pa}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-8">
                  <div className="p-4 bg-white/5 rounded-2xl border border-white/5 flex flex-col items-center justify-center gap-1.5">
                    <span className="text-[9px] font-black uppercase tracking-widest text-zinc-600">Protocol</span>
                    <span className="text-[11px] font-black text-white tracking-widest leading-none">NPCI V4.2</span>
                  </div>
                  <div className="p-4 bg-white/5 rounded-2xl border border-white/5 flex flex-col items-center justify-center gap-1.5">
                    <span className="text-[9px] font-black uppercase tracking-widest text-zinc-600">Encryption</span>
                    <span className="text-[11px] font-black text-[#E5D5B3] tracking-widest leading-none">AES-256</span>
                  </div>
                </div>

                <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl mb-8 flex gap-3 text-left">
                  <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-[10px] font-black uppercase tracking-widest text-amber-500">Action Required</p>
                    <p className="text-[11px] font-medium text-amber-500/70 leading-relaxed">
                      Payments to external VPAs are in sandbox. <span className="font-bold text-amber-500 uppercase tracking-tighter">Switch to Testnet</span> via Profile Settings to bridge assets and complete this transaction.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setScanResult(null)}
                    className="flex-1 py-4 bg-zinc-900 text-zinc-400 font-black rounded-[1.2rem] text-[10px] uppercase tracking-[0.2em] active:scale-[0.98] transition-all border border-white/5"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => setScanResult(null)}
                    className="flex-[2] py-5 gold-gradient text-black font-black rounded-2xl text-[10px] uppercase tracking-[0.3em] active:scale-[0.98] transition-all shadow-[0_20px_40px_rgba(229,213,179,0.2)]"
                  >
                    Acknowledged
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Instructions */}
        <div className="mt-12 text-center max-w-[200px]">
          <p className="text-zinc-400 text-sm font-medium leading-relaxed">
            Point your camera at a <span className="text-white font-bold">Stellar</span> or <span className="text-white font-bold">UPI</span> QR code
          </p>
        </div>
      </div>

      {/* Bottom Controls - Native Cam Look */}
      {!scanResult && (
        <div className="relative z-20 pb-20 px-10 flex justify-center items-center gap-10 animate-in fade-in duration-300">
          <button onClick={toggleFlash} className={`flex flex-col items-center gap-3 group ${!isScannerInitialized ? 'opacity-30 pointer-events-none' : ''}`}>
            <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-all backdrop-blur-lg border ${isFlashOn ? 'bg-[#E5D5B3] text-black border-[#E5D5B3]' : 'bg-white/5 text-zinc-400 border-white/10 group-hover:bg-white/10 group-hover:text-white'}`}>
              <Zap size={24} fill={isFlashOn ? "currentColor" : "none"} />
            </div>
            <span className={`text-[10px] font-black uppercase tracking-widest ${isFlashOn ? 'text-[#E5D5B3]' : 'text-zinc-500'}`}>Flash</span>
          </button>

          <button className="flex flex-col items-center gap-3 group">
            <div className="w-20 h-20 bg-[#E5D5B3] rounded-full flex items-center justify-center text-black shadow-[0_0_30px_rgba(229,213,179,0.3)] active:scale-95 transition-all">
              <QrCode size={30} />
            </div>
            <span className="text-[10px] font-black text-white uppercase tracking-widest">Gallery</span>
          </button>

          <button className="flex flex-col items-center gap-3 group" onClick={() => navigate("/sonic?mode=receive")}>
            <div className="w-16 h-16 bg-blue-500/10 border border-blue-500/20 rounded-full flex items-center justify-center text-blue-400 group-hover:bg-blue-500/20 group-hover:text-blue-300 transition-all backdrop-blur-lg">
              <Radio size={24} className="animate-pulse" />
            </div>
            <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest">Sonic Pulse</span>
          </button>
        </div>
      )}

      {/* Universal Choice Modal - MetaMask vs Ching Pay Selection */}
      {universalChoice && (
        <div className="fixed inset-0 z-[110] flex items-end justify-center">
          <div className="absolute inset-0 bg-black/90 backdrop-blur-xl" onClick={() => setUniversalChoice(null)}></div>

          <div className="relative w-full max-w-md bg-[#0a0f0a] rounded-t-[3rem] p-8 border-t border-white/10 animate-in slide-in-from-bottom duration-500">
            <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-8" />

            <div className="text-center mb-10">
              <h3 className="text-2xl font-black mb-2 tracking-tight">Choice of Payment</h3>
              <p className="text-zinc-500 text-[10px] font-black uppercase tracking-[0.3em]">Universal Protocol Detected</p>
            </div>

            <div className="grid grid-cols-1 gap-4 mb-8">
              {/* Option 1: External Wallet (MetaMask / Stellar Wallet) */}
              <button
                onClick={() => {
                  if (universalChoice.rawUri) window.location.href = universalChoice.rawUri;
                  setUniversalChoice(null);
                }}
                className="w-full p-6 bg-white/5 border border-white/10 rounded-3xl flex items-center justify-between group hover:bg-white/10 transition-all active:scale-[0.98]"
              >
                <div className="flex items-center gap-4 text-left">
                  <div className="w-12 h-12 bg-white/5 rounded-2xl flex items-center justify-center">
                    {universalChoice.type === 'ETH' ? (
                      <img src="https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Mirror_Logo.svg" className="w-8 h-8" alt="MetaMask" />
                    ) : (
                      <Wallet className="w-7 h-7 text-[#7C3AED]" />
                    )}
                  </div>
                  <div>
                    <p className="font-black text-white text-sm">Use External App</p>
                    <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
                      {universalChoice.type === 'ETH' ? 'Launch MetaMask' : 'Launch Stellar Wallet'}
                    </p>
                  </div>
                </div>
                <ArrowLeft className="rotate-[135deg] text-zinc-600 group-hover:text-white transition-colors" size={20} />
              </button>

              {/* Option 2: Native Ching Pay Bridge */}
              <button
                onClick={() => {
                  if (universalChoice.type === 'ETH') {
                    initiateCrossChainPayment(universalChoice.address, universalChoice.amount);
                  } else {
                    navigate(`/send?to=${universalChoice.address}&amt=${universalChoice.amount}&note=${universalChoice.memo || ''}`);
                  }
                  setUniversalChoice(null);
                }}
                className="w-full p-6 bg-[#E5D5B3]/5 border border-[#E5D5B3]/20 rounded-3xl flex items-center justify-between group hover:bg-[#E5D5B3]/10 transition-all active:scale-[0.98]"
              >
                <div className="flex items-center gap-4 text-left">
                  <div className="w-12 h-12 bg-[#E5D5B3]/20 rounded-2xl flex items-center justify-center">
                    <Zap size={24} className="text-[#E5D5B3]" />
                  </div>
                  <div>
                    <p className="font-black text-white text-sm">Pay via Ching Pay</p>
                    <p className="text-[10px] font-bold text-[#E5D5B3]/60 uppercase tracking-widest">
                      On-Platform Smart Bridge
                    </p>
                  </div>
                </div>
                <ArrowLeft className="rotate-[135deg] text-[#E5D5B3] group-hover:scale-110 transition-transform" size={20} />
              </button>
            </div>

            <div className="bg-zinc-900/50 rounded-2xl p-4 flex items-center gap-4 border border-white/5">
              <div className="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center shrink-0">
                <Info size={18} className="text-zinc-600" />
              </div>
              <div className="text-left">
                <p className="text-[9px] font-black text-zinc-500 uppercase tracking-widest leading-normal">
                  You are paying {universalChoice.type === 'ETH' ? 'Ethereum' : 'Stellar'} address: <br />
                  <span className="text-zinc-400 break-all">{universalChoice.address.slice(0, 20)}...</span>
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Instructions continued... */}
      <div className="flex flex-col items-center gap-1 mb-8 opacity-40">
        <div className="flex items-center gap-1.5 text-[#E5D5B3]">
          <Zap size={14} className="opacity-80" />
          <span className="text-[10px] font-black uppercase tracking-[0.2em]">Neural Engine</span>
        </div>
      </div>

      <style>{`
        @keyframes scan-line-slow {
            0% { transform: translateY(0); opacity: 0 }
            10% { opacity: 0.6 }
            90% { opacity: 0.6 }
            100% { transform: translateY(320px); opacity: 0 }
        }
        .animate-scan-slow {
            animation: scan-line-slow 2.5s ease-in-out infinite;
        }
        #reader { border: none !important; background: transparent !important; }
        #reader > div { border: none !important; } 
        #reader video { 
            border-radius: 1.5rem; 
            object-fit: cover !important; 
            width: 100% !important;
            height: 100% !important;
        }
        #reader__dashboard_section_csr button { 
            display: none !important;
        }
        #reader__status_span {
            display: none !important;
        }
        #reader__header_message {
            display: none !important;
        }
      `}</style>
    </div>
  );
};

export default QRScanner;
