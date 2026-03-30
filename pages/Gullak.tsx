
import React, { useState, useEffect } from 'react';
import { ArrowLeft, TrendingUp, PiggyBank, Zap, Flame, ArrowUpRight, ArrowDownLeft, Clock, ChevronRight, Sparkles, Target, Calendar, Shield, Gift, CheckCircle2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { UserProfile, TransactionRecord } from '../types';
import { getBalance } from '../services/stellar';
import { getLivePrice } from '../services/priceService';
import { applyGullakYield, getTransactions } from '../services/db';
import { useNetwork } from '../context/NetworkContext';
import { motion, AnimatePresence } from 'framer-motion';
import { collection, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '../services/firebase';
import { decryptSecret, encryptSecret } from '../services/encryption';
import { KYCService } from '../services/kycService';
import { sendPayment, isAccountFunded, mergeAccount } from '../services/stellar';
import { recordGullakWithdrawal, recordTransaction, updateUserDetails } from '../services/db';
import { PasskeyService } from '../services/passkeyService';
import { Fingerprint, Send, ShieldCheck, AlertCircle, Loader2 } from 'lucide-react';
import { getCurrencySymbol, formatFiat } from '../utils/currency';

interface Props {
    profile: UserProfile | null;
}

const GullakPage: React.FC<Props> = ({ profile }) => {
    const navigate = useNavigate();
    const { isMainnet } = useNetwork();
    const [balance, setBalance] = useState<string>('0.00'); // Gullak balance
    const [mainBalance, setMainBalance] = useState<string>('0.00'); // Main wallet balance
    const [xlmRate, setXlmRate] = useState<number>(15.02);
    const [loading, setLoading] = useState(true);
    const [justYielded, setJustYielded] = useState<number | null>(null);
    const [activeTab, setActiveTab] = useState<'overview' | 'history'>('overview');
    const [gullakHistory, setGullakHistory] = useState<TransactionRecord[]>([]);
    const [historyLoading, setHistoryLoading] = useState(true);

    const [showWithdrawModal, setShowWithdrawModal] = useState(false);
    const [pin, setPin] = useState('');
    const [withdrawing, setWithdrawing] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);
    const [authenticating, setAuthenticating] = useState(false);

    const [isGullakActivated, setIsGullakActivated] = useState(true);
    const [checkingActivation, setCheckingActivation] = useState(true);
    const [activating, setActivating] = useState(false);
    const [activationStatus, setActivationStatus] = useState('');
    const [showActivateModal, setShowActivateModal] = useState(false);

    useEffect(() => {
        const loadData = async () => {
            if (profile?.uid) {
                const bonus = await applyGullakYield(profile.uid);
                if (bonus) {
                    setJustYielded(bonus);
                    setTimeout(() => setJustYielded(null), 4000);
                }

                if (profile.gullakPublicKey) {
                    setCheckingActivation(true);
                    try {
                        const [balData, mainBalData, rate, isFunded] = await Promise.all([
                            getBalance(profile.gullakPublicKey).catch(() => '0.00'),
                            getBalance(profile.publicKey).catch(() => '0.00'),
                            getLivePrice('stellar', profile.preferredCurrency || 'INR'),
                            isAccountFunded(profile.gullakPublicKey)
                        ]);
                        const totalBal = typeof balData === 'string' ? balData : (balData as any).total || '0.00';
                        const totalMainBal = typeof mainBalData === 'string' ? mainBalData : (mainBalData as any).total || '0.00';

                        setBalance(totalBal);
                        setMainBalance(totalMainBal);
                        setXlmRate(rate);
                        setIsGullakActivated(isFunded || !!profile.gullakActivated);

                        // Auto-sync: If it's funded but the flag isn't set, set it now.
                        if (isFunded && !profile.gullakActivated) {
                            updateUserDetails(profile.uid, { gullakActivated: true }).catch(console.error);
                        }
                    } catch (e) {
                        console.error('Error loading Gullak data:', e);
                    } finally {
                        setCheckingActivation(false);
                    }
                }
            }
            setLoading(false);
        };
        loadData();

        // Real-time listener for Gullak Activity (Transactions with chillarAmount > 0)
        if (profile?.stellarId) {
            // Listen to transactions where the user is the sender (deposits)
            const qFrom = query(
                collection(db, 'transactions'),
                where('fromId', '==', profile.stellarId),
                limit(50)
            );

            // Listen to transactions where the user is the receiver (withdrawals from Gullak)
            const qTo = query(
                collection(db, 'transactions'),
                where('toId', '==', profile.stellarId),
                limit(50)
            );

            const handleSnapshot = (snapshot: any) => {
                const txs = snapshot.docs.map((doc: any) => ({
                    id: doc.id,
                    ...doc.data()
                })) as TransactionRecord[];

                setGullakHistory(prev => {
                    // Combine previous and new, deduplicate by ID
                    const combined = [...prev];
                    txs.forEach(newTx => {
                        const index = combined.findIndex(t => t.id === newTx.id);
                        if (index > -1) combined[index] = newTx;
                        else combined.push(newTx);
                    });

                    return combined
                        .filter(tx => (tx.chillarAmount || 0) > 0 || tx.isGullakWithdrawal)
                        .sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0))
                        .slice(0, 50);
                });
                setHistoryLoading(false);
            };

            const unsubscribeFrom = onSnapshot(qFrom, handleSnapshot);
            const unsubscribeTo = onSnapshot(qTo, handleSnapshot);

            return () => {
                unsubscribeFrom();
                unsubscribeTo();
            };
        }
    }, [profile]);

    const handleWithdrawAction = async () => {
        if (!profile) return;

        // Biometric check
        if (profile.passkeyEnabled) {
            setAuthenticating(true);
            try {
                const biometricSuccess = await PasskeyService.authenticatePasskey(profile);
                if (biometricSuccess) {
                    await executeWithdrawal();
                    return;
                }
            } catch (err) {
                console.error("Biometric failed:", err);
            } finally {
                setAuthenticating(false);
            }
        }

        if (profile.pin) {
            setShowWithdrawModal(true);
        } else {
            await executeWithdrawal('0000');
        }
    };

    const executeWithdrawal = async (entryPin?: string) => {
        if (!profile) return;

        const currency = profile.preferredCurrency || 'INR';
        const symbol = getCurrencySymbol(currency);
        const fiatValue = parseFloat(balance) * xlmRate;
        if (fiatValue < 10) {
            setError(`Minimum ${symbol}10 worth of savings required to withdraw`);
            return;
        }

        setWithdrawing(true);
        setError('');

        try {
            const phone = localStorage.getItem('ching_phone') || '';
            const encryptionKey = KYCService.deriveEncryptionKey(phone, entryPin || pin || '0000');

            let txHash = '';
            const isDedicatedVault = profile.gullakPublicKey && profile.gullakPublicKey !== profile.publicKey;

            if (isDedicatedVault && profile.gullakEncryptedSecret) {
                let secret = decryptSecret(profile.gullakEncryptedSecret, encryptionKey);

                if (!secret || !secret.startsWith('S')) {
                    // Fallback: Check if it was encrypted with the default '0000' PIN 
                    // (Common if user changed main PIN but Gullak secret didn't re-key)
                    const defaultKey = KYCService.deriveEncryptionKey(phone, '0000');
                    const fallbackSecret = decryptSecret(profile.gullakEncryptedSecret, defaultKey);

                    if (fallbackSecret && fallbackSecret.startsWith('S')) {
                        secret = fallbackSecret;
                        // Auto-sync: Re-encrypt with the CORRECT current PIN so it's fixed for next time
                        const correctKey = KYCService.deriveEncryptionKey(phone, entryPin || pin || profile.pin || '0000');
                        const fixedGullak = encryptSecret(secret, correctKey);
                        await updateUserDetails(profile.uid, { gullakEncryptedSecret: fixedGullak });
                        console.log("[Gullak] Auto-synced vault with current PIN");
                    } else {
                        throw new Error("Authorization failed. Incorrect PIN?");
                    }
                }

                // Move funds from Gullak to Main Wallet
                // Use mergeAccount to empty the vault completely (+ reclaim the 1 XLM reserve)
                txHash = await mergeAccount(secret, profile.publicKey);
            }

            // Record transaction in history
            await recordTransaction({
                fromId: profile.gullakPublicKey || 'Gullak',
                toId: profile.stellarId,
                fromName: 'My Gullak',
                toName: profile.displayName || profile.stellarId.split('@')[0],
                amount: totalSavings,
                currency: profile.preferredCurrency || 'INR',
                status: 'SUCCESS',
                txHash: txHash || 'INTERNAL_RELEASE',
                isGullakWithdrawal: true,
                category: 'Withdrawal'
            });

            // Reset Firestore counters
            await recordGullakWithdrawal(profile.uid, totalSavings);

            // Safety: Ensure activation flag is locked in so it doesn't reappear
            if (!profile.gullakActivated) {
                await updateUserDetails(profile.uid, { gullakActivated: true });
            }

            setSuccess(true);
            setShowWithdrawModal(false);
        } catch (err: any) {
            console.error("Withdrawal error:", err);
            setError(err.message || "Withdrawal failed");
        } finally {
            setWithdrawing(false);
        }
    };

    const handleActivateGullak = async (entryPin?: string) => {
        if (!profile) return;

        if (parseFloat(mainBalance) < 2.6) {
            setError("Insufficient funds in Main Wallet. You need at least 2.6 XLM (1.5 for activation + 1.0 reserve + buffer).");
            return;
        }

        setActivating(true);
        setError('');
        setActivationStatus('Authorizing...');

        try {
            const phone = profile.phoneNumber || localStorage.getItem('ching_phone') || '';
            console.log(`[Gullak] Activating vault with PIN: ${entryPin || pin || '0000'}`);
            const encryptionKey = KYCService.deriveEncryptionKey(phone, entryPin || pin || '0000');
            let secret = decryptSecret(profile.encryptedSecret, encryptionKey);

            if (!secret || !secret.startsWith('S')) {
                // Fallback for activation too
                const defaultKey = KYCService.deriveEncryptionKey(phone, '0000');
                const fallbackSecret = decryptSecret(profile.encryptedSecret, defaultKey);
                if (fallbackSecret && fallbackSecret.startsWith('S')) {
                    secret = fallbackSecret;
                    // Re-key the main secret if it worked with 0000 but the user has a different pin
                    if ((entryPin || pin || profile.pin) && (entryPin || pin || profile.pin) !== '0000') {
                        const correctKey = KYCService.deriveEncryptionKey(phone, entryPin || pin || profile.pin || '0000');
                        const fixedMain = encryptSecret(secret, correctKey);
                        await updateUserDetails(profile.uid, {
                            encryptedSecret: fixedMain,
                            pin: entryPin || pin || profile.pin
                        });
                    }
                } else {
                    console.error("[Gullak] Decryption failed - secret is invalid");
                    throw new Error("Security check failed. Please check your PIN.");
                }
            }

            console.log("[Gullak] Secret decrypted successfully, submitting transaction...");
            setActivationStatus('Submitting to Stellar...');
            // Send 1.5 XLM to activate the Gullak account (1.0 reserve + buffer for fees/future)
            const txHash = await sendPayment(secret, profile.gullakPublicKey!, "1.5", "Activate Gullak Vault");
            console.log("[Gullak] Activation transaction submitted:", txHash);

            // Check again and persist status to Firestore so the user doesn't see the card again
            const funded = await isAccountFunded(profile.gullakPublicKey!);
            setIsGullakActivated(true); // Forced true for UX as user just activated
            await updateUserDetails(profile.uid, { gullakActivated: true });

            setShowActivateModal(false);

            // Refresh balance
            const balData = await getBalance(profile.gullakPublicKey!);
            const totalBal = typeof balData === 'string' ? balData : (balData as any).total || '0.00';
            setBalance(totalBal);

        } catch (err: any) {
            console.error("Activation failed:", err);
            setError(err.message || "Activation failed");
        } finally {
            setActivating(false);
            setActivationStatus('');
        }
    };

    if (!profile) return null;

    const totalSavings = profile.totalSavingsINR || 0;
    const totalYield = profile.totalYieldEarnedINR || 0;
    const streak = profile.currentStreak || 0;
    const streakLevel = profile.streakLevel || 'orange';

    const streakConfig = {
        orange: { label: 'Starter', color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20', apr: '3.6%', rate: '0.01%/day', next: 5, nextLabel: 'Blue' },
        blue: { label: 'Saver', color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20', apr: '11%', rate: '0.03%/day', next: 15, nextLabel: 'Purple' },
        purple: { label: 'Pro Saver', color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20', apr: '18%', rate: '0.05%/day', next: 0, nextLabel: 'MAX' },
    };

    const cfg = streakConfig[streakLevel];
    const progressToNext = cfg.next > 0 ? Math.min(100, (streak / cfg.next) * 100) : 100;
    const currency = profile.preferredCurrency || 'INR';
    const symbol = getCurrencySymbol(currency);

    return (
        <div className="min-h-screen bg-[#050505] text-white pb-32 relative overflow-hidden">
            {/* Yield Toast */}
            <AnimatePresence>
                {justYielded && (
                    <motion.div
                        initial={{ y: -100, x: '-50%', opacity: 0 }}
                        animate={{ y: 60, x: '-50%', opacity: 1 }}
                        exit={{ y: -100, x: '-50%', opacity: 0 }}
                        className="fixed top-0 left-1/2 z-[100] bg-emerald-500 text-black px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest shadow-2xl flex items-center gap-2"
                    >
                        <Sparkles size={16} />
                        Daily Yield: +{symbol}{justYielded.toFixed(4)}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Ambient Glow */}
            <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[80%] h-[50%] bg-[#E5D5B3]/5 blur-[150px] rounded-full pointer-events-none" />
            <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[40%] bg-emerald-500/3 blur-[120px] rounded-full pointer-events-none" />

            {/* Header */}
            <div className="pt-14 px-6 flex items-center justify-between relative z-10">
                <button
                    onClick={() => navigate('/')}
                    className="w-11 h-11 flex items-center justify-center rounded-2xl bg-white/5 border border-white/10 text-zinc-400 hover:text-white transition-all active:scale-95"
                >
                    <ArrowLeft size={18} />
                </button>
                <div className="flex items-center gap-2">
                    <img src="/gullak.png" className="w-5 h-5 object-contain" alt="Gullak" />
                    <span className="text-sm font-black tracking-tight uppercase">Gullak</span>
                </div>
                <div className="w-11" />
            </div>

            {/* ═══ BALANCE HERO ═══ */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="px-6 pt-8 pb-4 relative z-10"
            >
                <div className="flex flex-col items-center">
                    {/* Animated Ring */}
                    <div className="relative w-44 h-44 flex items-center justify-center mb-6">
                        {/* Background Ring */}
                        <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 176 176">
                            <circle cx="88" cy="88" r="80" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="6" />
                            <motion.circle
                                cx="88" cy="88" r="80" fill="none"
                                stroke="url(#goldGradient)" strokeWidth="6"
                                strokeLinecap="round"
                                strokeDasharray={502.65}
                                initial={{ strokeDashoffset: 502.65 }}
                                animate={{ strokeDashoffset: 502.65 * (1 - Math.min(1, totalSavings / 10000)) }}
                                transition={{ duration: 2, ease: 'easeOut' }}
                            />
                            <defs>
                                <linearGradient id="goldGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                    <stop offset="0%" stopColor="#D4874D" />
                                    <stop offset="50%" stopColor="#E5C36B" />
                                    <stop offset="100%" stopColor="#F0D98A" />
                                </linearGradient>
                            </defs>
                        </svg>

                        {/* Center Content */}
                        <div className="flex flex-col items-center">
                            <span className="text-[9px] font-black uppercase tracking-[0.4em] text-zinc-600 mb-1">Total Saved</span>
                            <div className="flex items-baseline gap-1">
                                <span className="text-[#E5D5B3]/40 text-2xl font-black">{symbol}</span>
                                <span className="text-4xl font-black tracking-tight">
                                    {loading ? '...' : formatFiat(totalSavings, currency)}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Yield Earned Badge */}
                    <motion.div
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.4 }}
                        className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border border-emerald-500/15 rounded-full mb-2"
                    >
                        <TrendingUp size={12} className="text-emerald-400" />
                        <span className="text-[10px] font-black text-emerald-400 uppercase tracking-wider">
                            +{symbol}{formatFiat(totalYield, currency)} yield earned
                        </span>
                    </motion.div>

                    {/* XLM Balance */}
                    <p className="text-[10px] text-zinc-600 font-bold">
                        {parseFloat(balance).toFixed(4)} XLM • {symbol}{formatFiat(parseFloat(balance) * xlmRate, currency)} value
                    </p>
                </div>
            </motion.div>

            {/* ═══ STREAK TIER CARD ═══ */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="px-6 mb-6 relative z-10"
            >
                <div className={`${cfg.bg} border ${cfg.border} rounded-3xl p-5 relative overflow-hidden`}>
                    <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/5 to-transparent rounded-full -mr-16 -mt-16 pointer-events-none" />

                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-xl ${cfg.bg} border ${cfg.border} flex items-center justify-center`}>
                                <Flame size={20} className={cfg.color} />
                            </div>
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className={`text-xs font-black ${cfg.color}`}>{cfg.label} Tier</span>
                                    <span className="text-[8px] font-bold text-zinc-600 px-1.5 py-0.5 bg-white/5 rounded-md uppercase">{cfg.apr} APR</span>
                                </div>
                                <p className="text-[10px] text-zinc-500 font-bold mt-0.5">
                                    {streak} day streak • {cfg.rate}
                                </p>
                            </div>
                        </div>
                        <div className="flex flex-col items-end">
                            <span className={`text-2xl font-black ${cfg.color}`}>{streak}</span>
                            <span className="text-[8px] font-bold text-zinc-600 uppercase tracking-wider">Days</span>
                        </div>
                    </div>

                    {/* Progress Bar */}
                    {cfg.next > 0 && (
                        <div>
                            <div className="flex justify-between items-center mb-1.5">
                                <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-wider">Next: {cfg.nextLabel} Tier</span>
                                <span className="text-[9px] font-bold text-zinc-500">{streak}/{cfg.next} days</span>
                            </div>
                            <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                                <motion.div
                                    className="h-full rounded-full"
                                    style={{ background: 'linear-gradient(90deg, #D4874D, #E5C36B, #F0D98A)' }}
                                    initial={{ width: 0 }}
                                    animate={{ width: `${progressToNext}%` }}
                                    transition={{ duration: 1.5, ease: 'easeOut' }}
                                />
                            </div>
                        </div>
                    )}
                    {cfg.next === 0 && (
                        <div className="flex items-center gap-2 mt-1">
                            <Sparkles size={12} className="text-purple-400" />
                            <span className="text-[10px] font-bold text-purple-400">Max tier reached! Earning highest yield rate.</span>
                        </div>
                    )}
                </div>
            </motion.div>

            {/* ═══ TAB SWITCHER ═══ */}
            <div className="px-6 mb-5 relative z-10">
                <div className="flex bg-zinc-900/50 border border-white/5 rounded-2xl p-1">
                    {(['overview', 'history'] as const).map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === tab
                                ? 'bg-white/10 text-white'
                                : 'text-zinc-600 hover:text-zinc-400'
                                }`}
                        >
                            {tab === 'overview' ? 'Overview' : 'Activity'}
                        </button>
                    ))}
                </div>
            </div>

            {/* ═══ OVERVIEW TAB ═══ */}
            {activeTab === 'overview' && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="px-6 relative z-10"
                >
                    {/* Activation Card for New Users */}
                    {!isGullakActivated && !checkingActivation && (
                        <div className="bg-rose-500/10 border border-rose-500/20 rounded-3xl p-6 mb-8 text-center relative overflow-hidden group">
                            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                                <AlertCircle size={60} />
                            </div>
                            <div className="w-14 h-14 bg-rose-500/20 rounded-2xl flex items-center justify-center text-rose-500 mx-auto mb-4">
                                <ShieldCheck size={28} />
                            </div>
                            <h3 className="text-lg font-black mb-2 tracking-tight transition-colors group-hover:text-rose-400">Activate Savings Vault</h3>
                            <p className="text-zinc-500 text-[10px] font-bold leading-relaxed mb-6 max-w-[200px] mx-auto uppercase tracking-widest">
                                Your dedicated Gullak vault needs activation to start storing round-up savings.
                                <br /><span className="text-zinc-600">(Your Balance: {parseFloat(mainBalance).toFixed(2)} XLM)</span>
                            </p>
                            <button
                                onClick={async (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    console.log("[Gullak] Activate button clicked");

                                    if (activating || authenticating) return;
                                    setError('');

                                    if (profile.passkeyEnabled) {
                                        setAuthenticating(true);
                                        try {
                                            const success = await PasskeyService.authenticatePasskey(profile);
                                            if (success) {
                                                console.log("[Gullak] Biometric success, activating...");
                                                await handleActivateGullak('0000');
                                                return;
                                            }
                                        } catch (e) {
                                            console.error("[Gullak] Biometric error:", e);
                                            setError("Biometric authentication failed");
                                        }
                                        finally { setAuthenticating(false); }
                                    }

                                    if (profile.pin && profile.pin.length === 4) {
                                        console.log("[Gullak] PIN found, showing modal");
                                        setShowActivateModal(true);
                                    } else {
                                        console.log("[Gullak] No PIN/Biometrics, auto-activating with 0000");
                                        await handleActivateGullak('0000');
                                    }
                                }}
                                disabled={activating || authenticating}
                                className="w-full py-4 bg-rose-500 text-black rounded-2xl font-black text-xs uppercase tracking-widest active:scale-95 transition-all shadow-xl shadow-rose-500/20 flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                {activating || authenticating ? (
                                    <>
                                        <Loader2 size={14} className="animate-spin" />
                                        {activationStatus || 'Processing...'}
                                    </>
                                ) : (
                                    <>
                                        <Zap size={14} fill="currentColor" />
                                        Activate Now (1.5 XLM)
                                    </>
                                )}
                            </button>
                            {error && (
                                <p className="mt-4 text-rose-400 text-[10px] font-black uppercase tracking-widest animate-pulse">
                                    {error}
                                </p>
                            )}
                            <p className="mt-4 text-[8px] font-black text-zinc-600 uppercase tracking-widest">
                                *Required to meet network reserve (1 XLM)
                            </p>
                        </div>
                    )}

                    {/* Quick Stats */}
                    <div className="grid grid-cols-3 gap-3 mb-6">
                        <div className="bg-zinc-900/30 border border-white/5 rounded-2xl p-4 flex flex-col items-center text-center">
                            <Target size={16} className="text-[#E5D5B3] mb-2 opacity-60" />
                            <span className="text-lg font-black">{streak}</span>
                            <span className="text-[8px] font-bold text-zinc-600 uppercase tracking-wider mt-0.5">Day Streak</span>
                        </div>
                        <div className="bg-zinc-900/30 border border-white/5 rounded-2xl p-4 flex flex-col items-center text-center">
                            <TrendingUp size={16} className="text-emerald-400 mb-2 opacity-60" />
                            <span className="text-lg font-black text-emerald-400">+{formatFiat(totalYield, currency)}</span>
                            <span className="text-[8px] font-bold text-zinc-600 uppercase tracking-wider mt-0.5">Yield {symbol}</span>
                        </div>
                        <div className="bg-zinc-900/30 border border-white/5 rounded-2xl p-4 flex flex-col items-center text-center">
                            <Shield size={16} className="text-blue-400 mb-2 opacity-60" />
                            <span className="text-lg font-black">{cfg.apr}</span>
                            <span className="text-[8px] font-bold text-zinc-600 uppercase tracking-wider mt-0.5">APR</span>
                        </div>
                    </div>

                    {/* How It Works */}
                    <div className="bg-zinc-900/20 border border-white/5 rounded-3xl p-5 mb-6">
                        <div className="flex items-center gap-2 mb-4">
                            <Gift size={14} className="text-[#E5D5B3]" />
                            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[#E5D5B3]">How Gullak Works</span>
                        </div>

                        <div className="space-y-4">
                            {[
                                { step: '01', title: 'Pay Normally', desc: 'Make any UPI payment through Ching Pay', icon: ArrowUpRight },
                                { step: '02', title: 'Auto Round-up', desc: `Amount rounds up to nearest ${symbol}10 automatically`, icon: Sparkles },
                                { step: '03', title: 'Earn Yield', desc: `${cfg.apr} APR based on your ${streak}-day streak`, icon: TrendingUp },
                            ].map((item, i) => (
                                <div key={i} className="flex items-start gap-4">
                                    <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                                        <span className="text-[9px] font-black text-[#E5D5B3]">{item.step}</span>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-black text-white mb-0.5">{item.title}</p>
                                        <p className="text-[10px] text-zinc-500 font-medium leading-relaxed">{item.desc}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Gullak Address */}
                    {profile.gullakPublicKey && (
                        <div className="bg-zinc-900/20 border border-white/5 rounded-2xl p-4 flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                                <Shield size={14} className="text-zinc-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-wider">Vault Address</p>
                                <p className="text-[10px] text-zinc-400 font-mono truncate">
                                    {profile.gullakPublicKey}
                                </p>
                            </div>
                        </div>
                    )}
                </motion.div>
            )}

            {/* ═══ HISTORY TAB ═══ */}
            {activeTab === 'history' && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="px-6 relative z-10"
                >
                    {historyLoading ? (
                        <div className="flex justify-center py-20">
                            <div className="w-8 h-8 border-4 border-[#E5D5B3] border-t-transparent rounded-full animate-spin"></div>
                        </div>
                    ) : gullakHistory.length > 0 ? (
                        <div className="space-y-3">
                            {gullakHistory.map((tx) => {
                                const isWithdrawal = tx.isGullakWithdrawal || tx.category === 'Withdrawal';
                                return (
                                    <div key={tx.id} className="flex items-center gap-4 py-3 border-b border-white/5 last:border-0">
                                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isWithdrawal ? 'bg-orange-500/10' : 'bg-emerald-500/10'}`}>
                                            {isWithdrawal ? (
                                                <ArrowUpRight size={16} className="text-orange-400" />
                                            ) : (
                                                <ArrowDownLeft size={16} className="text-emerald-400" />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-bold text-white truncate">
                                                {isWithdrawal ? 'Savings Withdrawn' : 'Chillar Saved'}
                                            </p>
                                            <p className="text-[10px] text-zinc-600 font-medium truncate">
                                                {tx.timestamp ? new Date(tx.timestamp.seconds * 1000).toLocaleDateString(currency === 'INR' ? 'en-IN' : 'en-US', { day: 'numeric', month: 'short' }) : 'Just now'}
                                                {" • "} {isWithdrawal ? `From ${tx.fromName || 'My Gullak'}` : `via ${tx.toName || 'Payment'}`}
                                            </p>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className={`text-xs font-black ${isWithdrawal ? 'text-orange-400' : 'text-emerald-400'}`}>
                                                {isWithdrawal ? `-${symbol}` : `+${symbol}`}{formatFiat(isWithdrawal ? tx.amount : (tx.chillarAmount || 0), currency)}
                                            </p>
                                            <p className="text-[9px] text-zinc-600 font-bold uppercase tracking-widest">{isWithdrawal ? 'Payout' : 'Round-up'}</p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center py-16 text-center">
                            <div className="w-16 h-16 rounded-2xl bg-zinc-900/50 border border-white/5 flex items-center justify-center mb-4">
                                <Clock size={24} className="text-zinc-700" />
                            </div>
                            <p className="text-sm font-bold text-zinc-500 mb-1">No savings yet</p>
                            <p className="text-xs text-zinc-700 max-w-[200px]">
                                Make your first Chillar-enabled payment to start saving
                            </p>
                        </div>
                    )}
                </motion.div>
            )}

            {/* ═══ STICKY BOTTOM CTA ═══ */}
            <div className="fixed bottom-0 left-0 right-0 z-40 p-6 pb-10 bg-gradient-to-t from-[#050505] via-[#050505] to-transparent">
                <button
                    onClick={handleWithdrawAction}
                    disabled={loading || (parseFloat(balance) * xlmRate) < 10}
                    className="w-full h-14 rounded-2xl font-black text-xs uppercase tracking-widest shadow-2xl active:scale-[0.97] transition-all flex items-center justify-center gap-3 text-black disabled:opacity-50 disabled:grayscale"
                    style={{ background: 'linear-gradient(90deg, #D4874D 0%, #E5C36B 50%, #F0D98A 100%)' }}
                >
                    <img src="/gullak.png" className="w-6 h-6 object-contain" alt="Gullak" />
                    {(parseFloat(balance) * xlmRate) < 10 ? `Min. ${symbol}10 Required (Needed: ${symbol}${formatFiat(10 - totalSavings, currency)})` : 'Withdraw Savings'}
                </button>
            </div>

            {/* WITHDRAWAL MODAL */}
            <AnimatePresence>
                {showWithdrawModal && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/90 backdrop-blur-xl"
                    >
                        <div className="w-full max-w-sm flex flex-col items-center">
                            <div className="w-16 h-16 bg-[#E5D5B3]/10 rounded-2xl flex items-center justify-center text-[#E5D5B3] mb-8 border border-[#E5D5B3]/20">
                                <Shield size={32} />
                            </div>
                            <h3 className="text-2xl font-black mb-2 tracking-tight">Access Gullak</h3>
                            <p className="text-zinc-500 text-sm font-medium mb-12 uppercase tracking-widest text-center">
                                Enter your Transaction PIN to release<br />
                                <span className="text-white">{symbol}{formatFiat(totalSavings, currency)}</span> to your main vault
                            </p>

                            <div className="flex gap-4 mb-12">
                                {[0, 1, 2, 3].map((i) => (
                                    <div
                                        key={i}
                                        className={`w-4 h-4 rounded-full border-2 transition-all duration-300 ${pin.length > i ? 'bg-[#E5D5B3] border-[#E5D5B3] scale-125' : 'border-zinc-800'}`}
                                    />
                                ))}
                            </div>

                            <div className="grid grid-cols-3 gap-6 w-full max-w-[280px]">
                                {[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, 'del'].map((num, i) => (
                                    <button
                                        key={i}
                                        onClick={async () => {
                                            if (num === 'del') setPin(pin.slice(0, -1));
                                            else if (num !== '' && pin.length < 4) {
                                                const newPin = pin + num;
                                                setPin(newPin);
                                                if (newPin.length === 4) {
                                                    setError('');
                                                    await executeWithdrawal(newPin);
                                                    setPin('');
                                                }
                                            }
                                        }}
                                        className={`h-16 rounded-2xl flex items-center justify-center text-xl font-black transition-all ${num === '' ? 'pointer-events-none' : 'hover:bg-white/5 active:scale-90'}`}
                                    >
                                        {num === 'del' ? '←' : num}
                                    </button>
                                ))}
                            </div>

                            {error && <p className="mt-8 text-rose-500 text-[10px] font-black uppercase tracking-widest">{error}</p>}
                            {withdrawing && <p className="mt-8 text-[#E5D5B3] text-[10px] font-black uppercase tracking-widest animate-pulse">Relasing funds...</p>}

                            <button
                                onClick={() => { setShowWithdrawModal(false); setPin(''); setError(''); }}
                                className="mt-12 text-zinc-600 font-bold uppercase tracking-widest text-[10px] hover:text-white transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* SUCCESS MODAL */}
            <AnimatePresence>
                {success && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-black/95 backdrop-blur-2xl"
                    >
                        <div className="text-center flex flex-col items-center">
                            <div className="w-24 h-24 bg-emerald-500/10 rounded-full flex items-center justify-center mb-8 border border-emerald-500/20">
                                <motion.div
                                    initial={{ scale: 0 }}
                                    animate={{ scale: 1 }}
                                    transition={{ type: 'spring', damping: 12 }}
                                >
                                    <CheckCircle2 size={48} className="text-emerald-500" />
                                </motion.div>
                            </div>
                            <h2 className="text-3xl font-black mb-2 tracking-tight">Withdrawal Success!</h2>
                            <p className="text-zinc-500 mb-10 max-w-[240px]">
                                Your savings and yield have been transferred to your main wallet.
                            </p>
                            <button
                                onClick={() => { setSuccess(false); navigate('/'); }}
                                className="px-12 py-5 bg-white text-black rounded-2xl font-black text-xs uppercase tracking-widest hover:scale-105 active:scale-95 transition-all"
                            >
                                Done
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ACTIVATION MODAL */}
            <AnimatePresence>
                {showActivateModal && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/90 backdrop-blur-xl"
                    >
                        <div className="w-full max-w-sm flex flex-col items-center">
                            <div className="w-16 h-16 bg-rose-500/10 rounded-2xl flex items-center justify-center text-rose-500 mb-8 border border-rose-500/20">
                                <Zap size={32} fill="currentColor" />
                            </div>
                            <h3 className="text-2xl font-black mb-2 tracking-tight">Activate Gullak</h3>
                            <p className="text-zinc-500 text-sm font-medium mb-12 uppercase tracking-widest text-center">
                                Enter your Transaction PIN to send<br />
                                <span className="text-white">1.5 XLM</span> to activate your savings vault
                            </p>

                            <div className="flex gap-4 mb-12">
                                {[0, 1, 2, 3].map((i) => (
                                    <div
                                        key={i}
                                        className={`w-4 h-4 rounded-full border-2 transition-all duration-300 ${pin.length > i ? 'bg-rose-500 border-rose-500 scale-125' : 'border-zinc-800'}`}
                                    />
                                ))}
                            </div>

                            <div className="grid grid-cols-3 gap-6 w-full max-w-[280px]">
                                {[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, 'del'].map((num, i) => (
                                    <button
                                        key={i}
                                        onClick={async () => {
                                            if (num === 'del') setPin(pin.slice(0, -1));
                                            else if (num !== '' && pin.length < 4) {
                                                const newPin = pin + num;
                                                setPin(newPin);
                                                if (newPin.length === 4) {
                                                    setError('');
                                                    await handleActivateGullak(newPin);
                                                    setPin('');
                                                }
                                            }
                                        }}
                                        className={`h-16 rounded-2xl flex items-center justify-center text-xl font-black transition-all ${num === '' ? 'pointer-events-none' : 'hover:bg-white/5 active:scale-90'}`}
                                    >
                                        {num === 'del' ? '←' : num}
                                    </button>
                                ))}
                            </div>

                            {error && <p className="mt-8 text-rose-500 text-[10px] font-black uppercase tracking-widest">{error}</p>}
                            {activating && (
                                <div className="mt-8 flex items-center gap-2 text-rose-300 text-[10px] font-black uppercase tracking-widest animate-pulse">
                                    <Loader2 size={12} className="animate-spin" />
                                    Activating vault...
                                </div>
                            )}

                            <button
                                onClick={() => { setShowActivateModal(false); setPin(''); setError(''); }}
                                className="mt-12 text-zinc-600 font-bold uppercase tracking-widest text-[10px] hover:text-white transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default GullakPage;
