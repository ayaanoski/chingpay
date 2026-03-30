
import React, { useState, useRef } from 'react';
import { signInAnonymously } from 'firebase/auth';
import { auth } from '../services/firebase';
import { saveUser, getProfile, normalizePhone } from '../services/db';
import { createWallet } from '../services/stellar';
import { encryptSecret } from '../services/encryption';
import { generateStellarId } from '../services/web3';
import { useNavigate, useLocation } from 'react-router-dom';
import { ShieldCheck, Phone, Lock, ChevronRight, Loader2, CreditCard, User, ArrowLeft, CheckCircle2, Camera, ScanLine } from 'lucide-react';
import { UserProfile } from '../types';
import { useAuth } from '../context/AuthContext';
import { VerificationService } from '../services/verificationService';
import { KYCService } from '../services/kycService';
import { PANScannerService } from '../services/panScannerService';

type Step = 'welcome' | 'phone' | 'otp' | 'kyc';

const Login: React.FC = () => {
  const { refreshProfileSync } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from || '/';

  const [step, setStep] = useState<Step>('welcome');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  // Phone + OTP
  const [phoneInput, setPhoneInput] = useState('');
  const [otpInput, setOtpInput] = useState('');

  // KYC
  const [panInput, setPanInput] = useState('');
  const [nameInput, setNameInput] = useState('');

  // Scanner
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanDetected, setScanDetected] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── SCAN HANDLER ───

  const handleScanPAN = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setScanning(true);
    setScanProgress(0);
    setScanDetected(false);
    setError('');

    try {
      // Pre-process image for better OCR accuracy
      const processed = await PANScannerService.preprocessImage(file);

      setScanProgress(20);

      // Run OCR
      const result = await PANScannerService.scanPANCard(processed);

      setScanProgress(100);

      if (result.panNumber) {
        setPanInput(result.panNumber);
        setScanDetected(true);
      }
      if (result.fullName) {
        setNameInput(result.fullName);
        setScanDetected(true);
      }

      if (!result.panNumber && !result.fullName) {
        setError('Could not detect PAN details. Please try again or enter manually.');
      }

      // Brief delay to show success state
      setTimeout(() => setScanning(false), 600);
    } catch (err: any) {
      console.error('PAN scan error:', err);
      setError('Scan failed. Please try again or enter manually.');
      setScanning(false);
    }

    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ─── STEP HANDLERS ───

  const handleSendOTP = async () => {
    const cleaned = normalizePhone(phoneInput);
    if (cleaned.length < 10) {
      setError('Enter a valid 10-digit phone number');
      return;
    }

    setLoading(true);
    setError('');
    setStatus('Sending OTP...');

    try {
      const success = await VerificationService.sendOTP(cleaned);
      if (success) {
        setStep('otp');
        setStatus('');
        // Auto-fill OTP if returned by server
        const savedOtp = sessionStorage.getItem('last_otp');
        if (savedOtp) {
          setOtpInput(savedOtp);
        }
      } else {
        setError('Failed to send OTP. Try again.');
      }
    } catch (err: any) {
      setError('Server error. Please try again later.');
    } finally {
      setLoading(false);
      setStatus('');
    }
  };

  const handleVerifyOTP = async () => {
    if (otpInput.length < 4) {
      setError('Enter the complete OTP');
      return;
    }

    setLoading(true);
    setError('');
    setStatus('Verifying...');

    try {
      const phone = normalizePhone(phoneInput);
      const success = await VerificationService.verifyOTP(phone, otpInput);

      if (!success) {
        setError('Invalid OTP. Please try again.');
        setLoading(false);
        setStatus('');
        return;
      }

      // Check if user already exists
      if (!auth.currentUser) await signInAnonymously(auth);

      const existingProfile = await getProfile(phone);

      if (existingProfile && existingProfile.isVerified) {
        // Existing user — login directly
        finalizeLogin(phone);
      } else {
        // New user — go to KYC
        setStep('kyc');
        setStatus('');
        setLoading(false);
      }
    } catch (err: any) {
      setError('Verification failed. Try again.');
      setLoading(false);
      setStatus('');
    }
  };

  const handleKYC = async () => {
    setError('');
    setLoading(true);
    setStatus('Generating ZK Identity Proof...');

    try {
      // Generate ZK KYC proof using Stellar X-Ray (Protocol 25)
      const kycResult = await KYCService.verifyPAN(panInput, nameInput);
      if (!kycResult.valid || !kycResult.proof) {
        setError(kycResult.error || 'Invalid PAN card');
        setLoading(false);
        setStatus('');
        return;
      }

      setStatus('Creating your Stellar wallet...');

      const phone = normalizePhone(phoneInput);

      if (!auth.currentUser) await signInAnonymously(auth);

      // Generate Stellar wallets
      const { publicKey, secret } = await createWallet();
      const { publicKey: gullakPk, secret: gullakSecret } = await createWallet();

      // Derive encryption key from phone + default PIN
      const encryptionKey = KYCService.deriveEncryptionKey(phone, '0000');
      const encryptedSecret = encryptSecret(secret, encryptionKey);
      const encryptedGullakSecret = encryptSecret(gullakSecret, encryptionKey);

      // Generate Stellar ID from phone
      const stellarId = generateStellarId(phone);

      setStatus('Anchoring KYC proof on-chain...');

      // Build profile with ZK KYC proof data
      const profile: UserProfile = {
        uid: phone,
        email: `${phone}@ching.pay`,
        phoneNumber: phone,
        isVerified: true,
        stellarId,
        publicKey,
        encryptedSecret,
        gullakPublicKey: gullakPk,
        gullakEncryptedSecret: encryptedGullakSecret,
        isFamilyOwner: true,
        displayName: nameInput.split(' ')[0], // First name
        fullName: nameInput,
        avatarSeed: phone,
        createdAt: new Date().toISOString(),
        currentStreak: 0,
        streakLevel: 'orange',
        panHash: kycResult.proof.proofHash,
        kycVerified: true,
        kycVerifiedAt: kycResult.proof.verifiedAt,
      };

      await saveUser(profile);

      setStatus('Welcome to Ching Pay!');
      finalizeLogin(phone);
    } catch (err: any) {
      console.error('KYC and Wallet creation failed:', err);
      setError(err.message || 'Account creation failed. Please try again.');
      setLoading(false);
      setStatus('');
    }
  };

  const finalizeLogin = (phone: string) => {
    localStorage.setItem('ching_phone', phone);
    refreshProfileSync(phone);
    setStatus('Welcome to Ching Pay!');
    setTimeout(() => navigate(from), 600);
  };

  // ─── RENDER ───

  return (
    <div className="min-h-screen bg-black text-white flex flex-col relative overflow-hidden">

      {/* Background */}
      <div className="absolute inset-0 z-0">
        <div className="absolute top-[8%] right-[0%] w-[70%] h-[45%] rounded-full blur-[120px]" style={{ background: 'rgba(139, 106, 62, 0.15)' }} />
        <div className="absolute top-[20%] left-[5%] w-[40%] h-[30%] rounded-full blur-[100px]" style={{ background: 'rgba(139, 106, 62, 0.08)' }} />
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-transparent" />
        <svg className="absolute inset-0 w-full h-full z-10" viewBox="0 0 400 900" preserveAspectRatio="xMidYMid slice">
          <line x1="20" y1="0" x2="380" y2="650" stroke="rgba(229,213,179,0.15)" strokeWidth="0.8" />
          <line x1="160" y1="0" x2="400" y2="480" stroke="rgba(229,213,179,0.12)" strokeWidth="0.7" />
          <line x1="0" y1="120" x2="400" y2="300" stroke="rgba(229,213,179,0.10)" strokeWidth="0.7" />
          <line x1="370" y1="0" x2="40" y2="580" stroke="rgba(229,213,179,0.13)" strokeWidth="0.7" />
          <line x1="0" y1="30" x2="280" y2="900" stroke="rgba(229,213,179,0.08)" strokeWidth="0.6" />
          <line x1="280" y1="0" x2="0" y2="450" stroke="rgba(229,213,179,0.09)" strokeWidth="0.6" />
        </svg>
      </div>

      {/* ═══ WELCOME STEP ═══ */}
      {step === 'welcome' && (
        <div className="relative z-10 flex-1 flex flex-col justify-end px-8 pb-14">
          <div className="mb-6">
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M22 4L38 14V30L22 40L6 30V14L22 4Z" stroke="white" strokeWidth="2.5" fill="none" />
              <path d="M14 18L22 13L30 18V28L22 33L14 28V18Z" fill="white" />
            </svg>
          </div>
          <h1 className="text-[32px] font-extrabold leading-[1.15] tracking-tight mb-10">
            <span className="text-[#E5D5B3]">Ching Pay</span> – UPI
            {'\u00A0'}for Seamless Digital Payments
          </h1>

          <button
            onClick={() => setStep('phone')}
            className="w-full h-[60px] rounded-full font-bold text-[16px] text-black relative overflow-hidden active:scale-[0.97] transition-transform mb-4"
            style={{ background: 'linear-gradient(90deg, #D4874D 0%, #E5C36B 50%, #F0D98A 100%)' }}
          >
            Let's Start
          </button>

          <p className="text-center text-zinc-700 text-[10px] mt-4 uppercase tracking-widest font-bold">
            Built on Stellar Protocol
          </p>
        </div>
      )}

      {/* ═══ PHONE STEP ═══ */}
      {step === 'phone' && (
        <div className="relative z-10 flex-1 flex flex-col px-8 pt-14">
          <button onClick={() => setStep('welcome')} className="w-12 h-12 flex items-center justify-center bg-white/5 border border-white/10 rounded-2xl text-zinc-400 mb-10">
            <ArrowLeft size={20} />
          </button>

          <div className="flex-1 flex flex-col">
            <div className="w-16 h-16 bg-[#E5D5B3]/10 rounded-2xl flex items-center justify-center text-[#E5D5B3] mb-6 border border-[#E5D5B3]/20">
              <Phone size={28} />
            </div>
            <h2 className="text-2xl font-black tracking-tight mb-2">Enter your phone</h2>
            <p className="text-zinc-500 text-sm mb-10">We'll send a verification code via SMS</p>

            <div className="relative group mb-6">
              <Phone className="absolute left-5 top-1/2 -translate-y-1/2 text-zinc-600 group-focus-within:text-[#E5D5B3] transition-colors" size={18} />
              <input
                type="tel"
                name="phone"
                autoComplete="tel"
                placeholder="Enter Phone Number"
                value={phoneInput}
                onChange={(e) => { setPhoneInput(e.target.value); setError(''); }}
                className="w-full bg-zinc-950 border border-white/5 rounded-2xl py-5 pl-14 pr-6 font-bold text-sm outline-none focus:border-[#E5D5B3]/20 transition-all font-mono"
                autoFocus
              />
            </div>

            {error && <p className="text-rose-400 text-xs font-bold mb-4 uppercase tracking-wider">{error}</p>}
          </div>

          <div className="pb-14">
            <button
              onClick={handleSendOTP}
              disabled={loading || phoneInput.replace(/\D/g, '').length < 10}
              className="w-full h-16 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all shadow-lg text-black disabled:opacity-40"
              style={{ background: 'linear-gradient(90deg, #D4874D 0%, #E5C36B 50%, #F0D98A 100%)' }}
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : <>Send OTP <ChevronRight size={18} strokeWidth={3} /></>}
            </button>
          </div>
        </div>
      )}

      {/* ═══ OTP STEP ═══ */}
      {step === 'otp' && (
        <div className="relative z-10 flex-1 flex flex-col px-8 pt-14">
          <button onClick={() => { setStep('phone'); setOtpInput(''); setError(''); }} className="w-12 h-12 flex items-center justify-center bg-white/5 border border-white/10 rounded-2xl text-zinc-400 mb-10">
            <ArrowLeft size={20} />
          </button>

          <div className="flex-1 flex flex-col">

            <h2 className="text-2xl font-black tracking-tight mb-2">Verify SMS Code</h2>
            <p className="text-zinc-500 text-sm mb-10">Enter the 6-digit code sent to <span className="text-[#E5D5B3]">{phoneInput}</span></p>

            <div className="flex justify-center mb-6">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="- - - - - -"
                value={otpInput}
                onChange={(e) => { setOtpInput(e.target.value.replace(/\D/g, '')); setError(''); }}
                className="w-full max-w-[240px] bg-zinc-950 border border-white/5 rounded-2xl py-6 px-4 font-black text-2xl tracking-[0.4em] text-center outline-none focus:border-[#E5D5B3]/20 transition-all text-[#E5D5B3]"
                autoFocus
              />
            </div>

            {error && <p className="text-rose-400 text-xs font-bold mb-4 uppercase tracking-wider text-center">{error}</p>}
            {status && <p className="text-[#E5D5B3] text-xs font-bold mb-4 uppercase tracking-wider text-center">{status}</p>}
          </div>

          <div className="pb-14">
            <button
              onClick={handleVerifyOTP}
              disabled={loading || otpInput.length < 4}
              className="w-full h-16 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all shadow-lg text-black disabled:opacity-40"
              style={{ background: 'linear-gradient(90deg, #D4874D 0%, #E5C36B 50%, #F0D98A 100%)' }}
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : <>Verify <ChevronRight size={18} strokeWidth={3} /></>}
            </button>

            <button onClick={handleSendOTP} disabled={loading} className="w-full mt-4 py-3 text-zinc-600 text-xs font-bold uppercase tracking-widest">
              Resend Code
            </button>
          </div>
        </div>
      )}

      {/* ═══ KYC STEP ═══ */}
      {step === 'kyc' && (
        <div className="relative z-10 flex-1 flex flex-col px-8 pt-14">
          <button onClick={() => { setStep('otp'); setError(''); }} className="w-12 h-12 flex items-center justify-center bg-white/5 border border-white/10 rounded-2xl text-zinc-400 mb-10">
            <ArrowLeft size={20} />
          </button>

          {/* Scanning Overlay */}
          {scanning && (
            <div className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center px-8">
              <div className="relative w-24 h-24 mb-8">
                <div className="absolute inset-0 rounded-3xl border-2 border-[#E5D5B3]/30 animate-pulse" />
                <div className="absolute inset-0 rounded-3xl flex items-center justify-center">
                  <ScanLine size={40} className="text-[#E5D5B3] animate-bounce" />
                </div>
              </div>
              <h3 className="text-xl font-black text-white mb-2">Scanning PAN Card</h3>
              <p className="text-zinc-500 text-sm mb-6">Extracting details using ML...</p>
              <div className="w-full max-w-[200px] h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#D4874D] to-[#E5C36B] rounded-full transition-all duration-500"
                  style={{ width: `${scanProgress}%` }}
                />
              </div>
              <p className="text-[#E5D5B3] text-xs font-bold mt-3 uppercase tracking-wider">{scanProgress < 100 ? 'Processing...' : 'Done!'}</p>
            </div>
          )}

          <div className="flex-1 flex flex-col">
            <h2 className="text-2xl font-black tracking-tight mb-2">Verify Identity</h2>
            <p className="text-zinc-500 text-sm mb-6">Scan your PAN card or enter details manually</p>

            {/* Scan Button */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleScanPAN}
              className="hidden"
              id="panScanInput"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={scanning}
              className="w-full bg-[#E5D5B3]/10 border border-[#E5D5B3]/20 rounded-2xl py-4 px-5 flex items-center gap-4 mb-6 active:scale-[0.98] transition-all hover:bg-[#E5D5B3]/15 disabled:opacity-50"
            >
              <div className="w-12 h-12 bg-[#E5D5B3]/10 rounded-xl flex items-center justify-center">
                <Camera size={22} className="text-[#E5D5B3]" />
              </div>
              <div className="text-left flex-1">
                <p className="text-sm font-black text-white">Scan PAN Card</p>
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Take photo or upload image</p>
              </div>
              <ChevronRight size={16} className="text-zinc-600" />
            </button>

            {/* Scan success indicator */}
            {scanDetected && (
              <div className="flex items-center gap-2 mb-4 px-1">
                <CheckCircle2 size={14} className="text-emerald-500" />
                <p className="text-emerald-500 text-xs font-bold uppercase tracking-wider">Details detected — review below</p>
              </div>
            )}

            {/* Manual Input Fields */}
            <div className="space-y-4 mb-6">
              <div className="relative group">
                <User className="absolute left-5 top-1/2 -translate-y-1/2 text-zinc-600 group-focus-within:text-[#E5D5B3] transition-colors" size={18} />
                <input
                  type="text"
                  placeholder="Full Name (as on PAN)"
                  value={nameInput}
                  onChange={(e) => { setNameInput(e.target.value); setError(''); }}
                  className="w-full bg-zinc-950 border border-white/5 rounded-2xl py-5 pl-14 pr-6 font-bold text-sm outline-none focus:border-[#E5D5B3]/20 transition-all capitalize"
                />
              </div>

              <div className="relative group">
                <CreditCard className="absolute left-5 top-1/2 -translate-y-1/2 text-zinc-600 group-focus-within:text-[#E5D5B3] transition-colors" size={18} />
                <input
                  type="text"
                  placeholder="PAN Number (e.g. ABCPD1234E)"
                  value={panInput}
                  maxLength={10}
                  onChange={(e) => { setPanInput(e.target.value.toUpperCase()); setError(''); }}
                  className="w-full bg-zinc-950 border border-white/5 rounded-2xl py-5 pl-14 pr-6 font-bold text-sm outline-none focus:border-[#E5D5B3]/20 transition-all font-mono uppercase tracking-wider"
                />
              </div>
            </div>

            {error && <p className="text-rose-400 text-xs font-bold mb-4 uppercase tracking-wider">{error}</p>}
            {status && <p className="text-[#E5D5B3] text-xs font-bold mb-4 uppercase tracking-wider">{status}</p>}

            <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-4 mb-6">
              <div className="flex items-start gap-3">
                <ShieldCheck size={16} className="text-emerald-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-[10px] text-zinc-400 leading-relaxed">
                    Powered by <span className="text-[#E5D5B3] font-bold">Stellar X-Ray (Protocol 25)</span>. Your PAN is verified using zero-knowledge proofs — only a cryptographic commitment is stored on-chain. We never save your raw PAN.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="pb-14">
            <button
              onClick={handleKYC}
              disabled={loading || !panInput || !nameInput}
              className="w-full h-16 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all shadow-lg text-black disabled:opacity-40"
              style={{ background: 'linear-gradient(90deg, #D4874D 0%, #E5C36B 50%, #F0D98A 100%)' }}
            >
              {loading ? (
                <div className="flex items-center gap-2">
                  <Loader2 size={18} className="animate-spin" />
                  <span className="text-sm normal-case font-bold tracking-normal">{status || 'Processing...'}</span>
                </div>
              ) : (
                <>Create Wallet <ChevronRight size={18} strokeWidth={3} /></>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Login;