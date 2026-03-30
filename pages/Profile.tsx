
import React, { useState, useEffect } from 'react';
import { UserProfile } from '../types';
import { updateUserDetails } from '../services/db';
import {
    ArrowLeft,
    ChevronRight,
    Wallet,
    Edit3,
    History,
    Settings,
    Trophy,
    Camera,
    Check,
    RefreshCw,
    LogOut,
    Smartphone,
    ShieldCheck,
    Mail,
    Copy,
    QrCode,
    SmartphoneIcon
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

declare global {
    interface Window {
        cloudinary: any;
    }
}

interface Props {
    profile: UserProfile | null;
}

const Profile: React.FC<Props> = ({ profile }) => {
    const navigate = useNavigate();
    const [saving, setSaving] = useState(false);
    const [copied, setCopied] = useState<'id' | 'key' | null>(null);
    const [avatarSeed, setAvatarSeed] = useState(profile?.avatarSeed || profile?.stellarId || 'custom-seed');
    const [nickname, setNickname] = useState(profile?.displayName || '');

    // Modals
    const [showLimitModal, setShowLimitModal] = useState(false);
    const [showPhoneModal, setShowPhoneModal] = useState(false);
    const [dailyLimitEntry, setDailyLimitEntry] = useState(profile?.dailyLimit || 0);
    const [phoneEntry, setPhoneEntry] = useState(profile?.phoneNumber || '');
    const [showCurrencyModal, setShowCurrencyModal] = useState(false);

    useEffect(() => {
        if (profile) {
            setNickname(profile.displayName || profile.stellarId.split('@')[0]);
            setAvatarSeed(profile.avatarSeed || profile.stellarId);
            setDailyLimitEntry(profile.dailyLimit || 0);
            setPhoneEntry(profile.phoneNumber || '');
        }
    }, [profile]);

    if (!profile) return null;

    const handleCopy = (text: string, type: 'id' | 'key') => {
        navigator.clipboard.writeText(text);
        setCopied(type);
        setTimeout(() => setCopied(null), 2000);
    };

    const handleUploadClick = () => {
        if (!window.cloudinary) return;
        const widget = window.cloudinary.createUploadWidget(
            {
                cloudName: 'diecfwnp9',
                uploadPreset: 'jo9pp2yd',
                styles: { palette: { window: "#000000", windowBorder: "#E5D5B3", tabIcon: "#E5D5B3", sourceBg: "#000000" } }
            },
            (error: any, result: any) => {
                if (!error && result && result.event === "success") {
                    const url = result.info.secure_url;
                    setAvatarSeed(url);
                    updateUserDetails(profile.uid, { avatarSeed: url });
                }
            }
        );
        widget.open();
    };

    const handleLogout = () => {
        localStorage.removeItem('ching_phone');
        window.location.href = '/login';
    };

    const avatarUrl = avatarSeed.startsWith('http')
        ? avatarSeed
        : `https://api.dicebear.com/7.x/lorelei/svg?seed=${avatarSeed}`;

    const remaining = Math.max(0, (profile.dailyLimit || 0) - (profile.spentToday || 0));

    const MenuSection = ({ title, children }: { title?: string, children: React.ReactNode }) => (
        <div className="mx-6 mb-6">
            {title && <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-3 px-1">{title}</p>}
            <div className="bg-black/10 rounded-[2rem] overflow-hidden shadow-sm ">
                {children}
            </div>
        </div>
    );

    const MenuItem = ({ icon: Icon, label, value, onClick, showArrow = true, iconColor = "text-[#E5D5B3] -500" }: { icon: any, label: string, value?: string, onClick?: () => void, showArrow?: boolean, iconColor?: string }) => (
        <button
            onClick={onClick}
            className="w-full flex items-center justify-between p-4 bg-transparent active:bg-zinc-50 transition-all  last:border-none"
        >
            <div className="flex items-center gap-4 flex-1 min-w-0">
                <div className={`w-10 h-10 rounded-xl bg-gradient-to-br from-[#E5D5B3]/10 to-[#E5D5B3]/5 border-white/5 text-[#E5D5B3] flex items-center justify-center ${iconColor}`}>
                    <Icon size={20} />
                </div>
                <div className="text-left min-w-0 flex-1">
                    <p className="text-[13px] font-bold text-zinc-200 truncate">{label}</p>
                    {value && <p className="text-[11px] font-medium text-zinc-400 truncate mt-0.5">{value}</p>}
                </div>
            </div>
            {showArrow && <ChevronRight size={16} className="text-zinc-300 ml-2" />}
        </button>
    );

    return (
        <div className="min-h-screen bg-black flex flex-col">
            {/* Header Section */}
            <div className="pt-12 pb-10 flex flex-col items-center relative">
                <button
                    onClick={() => navigate("/")}
                    className="absolute top-6 left-6 w-10 h-10 flex items-center justify-center text-white/40 hover:text-white transition-colors"
                >
                    <ArrowLeft size={24} />
                </button>

                <div className="relative mb-6">
                    <div className="w-28 h-28 rounded-full border-2 border-white/10 p-1 overflow-hidden bg-zinc-800">
                        <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover rounded-full" />
                    </div>
                    <button
                        onClick={handleUploadClick}
                        className="absolute bottom-0 right-0 w-8 h-8 bg-zinc-900 border border-white/20 rounded-full flex items-center justify-center text-white shadow-xl"
                    >
                        <Camera size={14} />
                    </button>
                </div>

                <h1 className="text-2xl font-black text-white tracking-tight mb-1">{nickname}</h1>
                <p className="text-zinc-500 text-xs font-medium tracking-wide uppercase opacity-60">{profile.stellarId}</p>
            </div>

            {/* Content Section */}
            <div className="flex-1 bg-white/10 rounded-t-[2.5rem] pt-8 pb-32">

                {/* Financial Health */}
                <MenuSection title="Account & Wallet">
                    <MenuItem
                        icon={Wallet}
                        label="Manage Wallet"
                        value={`Balance: ₹${((profile.dailyLimit || 0) * 8.4).toFixed(2)} equivalent`} // Dummy calc for visual
                        onClick={() => navigate('/add-money')}
                    />
                    <MenuItem
                        icon={ShieldCheck}
                        label="Spending Limit"
                        value={`${profile.preferredCurrency === 'INR' || !profile.preferredCurrency ? '₹' : profile.preferredCurrency + ' '}${remaining} remaining today`}
                        onClick={() => setShowLimitModal(true)}
                    />
                    <MenuItem
                        icon={Settings}
                        label="Currency Preference"
                        value={profile.preferredCurrency || 'Detecting...'}
                        onClick={() => setShowCurrencyModal(true)}
                    />
                </MenuSection>

                {/* Personal Information */}
                <MenuSection title="Personal Info">
                    <MenuItem
                        icon={Mail}
                        label="Email Address"
                        value={profile.email}
                        showArrow={false}
                    />
                    <MenuItem
                        icon={Smartphone}
                        label="Phone Number"
                        value={profile.phoneNumber || 'Not linked'}
                        onClick={() => setShowPhoneModal(true)}
                    />
                    <MenuItem
                        icon={Copy}
                        label="Wallet Address"
                        value={profile.publicKey}
                        onClick={() => handleCopy(profile.publicKey, 'key')}
                        showArrow={false}
                    />
                </MenuSection>



                {/* Logout */}
                <div className="px-6 mt-4">
                    <button
                        onClick={handleLogout}
                        className="w-full flex items-center justify-center gap-3 p-5 bg-black/20  rounded-[2rem] text-rose-500 font-bold active:bg-rose-50 transition-all shadow-sm"
                    >
                        <LogOut size={20} />
                        Sign Out
                    </button>
                    <p className="text-center text-zinc-400 text-[9px] font-black uppercase tracking-[0.3em] mt-8 opacity-40">
                        Ching Pay • Secure Wallet Build 1.0.4
                    </p>
                </div>
            </div>

            {/* Modals - Re-implemented for the new UI consistency */}
            {showLimitModal && (
                <div className="fixed inset-0 z-[100] flex items-end">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowLimitModal(false)} />
                    <div className="relative w-full bg-white rounded-t-[2.5rem] p-8 pb-12 animate-in slide-in-from-bottom duration-300">
                        <div className="w-12 h-1.5 bg-zinc-100 rounded-full mx-auto mb-8" />
                        <h3 className="text-2xl font-black text-zinc-900 mb-2">Spending Limit</h3>
                        <p className="text-zinc-400 text-sm mb-8">Set your maximum daily allowance for transactions.</p>

                        <div className="bg-zinc-50 rounded-[2rem] p-6 border border-zinc-100 mb-8 flex items-center gap-4">
                            <span className="text-3xl font-black text-zinc-300">₹</span>
                            <input
                                type="number"
                                value={dailyLimitEntry}
                                onChange={(e) => setDailyLimitEntry(Number(e.target.value))}
                                className="bg-transparent text-3xl font-black outline-none w-full text-zinc-900"
                                autoFocus
                            />
                        </div>

                        <button
                            onClick={async () => {
                                setSaving(true);
                                try { await updateUserDetails(profile.uid, { dailyLimit: dailyLimitEntry }); setShowLimitModal(false); }
                                catch (err) { console.error("Error updating limit:", err); } finally { setSaving(false); }
                            }}
                            className="w-full py-5 gold-gradient text-black rounded-2xl font-black uppercase tracking-widest text-xs"
                        >
                            {saving ? 'Updating...' : 'Update Limit'}
                        </button>
                    </div>
                </div>
            )}

            {showPhoneModal && (
                <div className="fixed inset-0 z-[100] flex items-end">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowPhoneModal(false)} />
                    <div className="relative w-full bg-white rounded-t-[2.5rem] p-8 pb-12 animate-in slide-in-from-bottom duration-300">
                        <div className="w-12 h-1.5 bg-zinc-100 rounded-full mx-auto mb-8" />
                        <h3 className="text-2xl font-black text-zinc-900 mb-2">Link Phone</h3>
                        <p className="text-zinc-400 text-sm mb-8">Update your linked phone number for secure alerts.</p>

                        <div className="bg-zinc-50 rounded-[2rem] p-6 border border-zinc-100 mb-8 items-center flex gap-4">
                            <SmartphoneIcon size={24} className="text-zinc-300" />
                            <input
                                type="tel"
                                value={phoneEntry}
                                onChange={(e) => setPhoneEntry(e.target.value)}
                                className="bg-transparent text-xl font-bold outline-none w-full text-zinc-900"
                                placeholder="+91 00000 00000"
                                autoFocus
                            />
                        </div>

                        <button
                            onClick={async () => {
                                setSaving(true);
                                try { await updateUserDetails(profile.uid, { phoneNumber: phoneEntry }); setShowPhoneModal(false); }
                                catch (err) { console.error(err); } finally { setSaving(false); }
                            }}
                            className="w-full py-5 gold-gradient text-black rounded-2xl font-black uppercase tracking-widest text-xs"
                        >
                            {saving ? 'Saving...' : 'Save Number'}
                        </button>
                    </div>
                </div>
            )}
            {showCurrencyModal && (
                <div className="fixed inset-0 z-[100] flex items-end">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowCurrencyModal(false)} />
                    <div className="relative w-full bg-white rounded-t-[2.5rem] p-8 pb-12 animate-in slide-in-from-bottom duration-300">
                        <div className="w-12 h-1.5 bg-zinc-100 rounded-full mx-auto mb-8" />
                        <h3 className="text-2xl font-black text-zinc-900 mb-2">Local Fiat</h3>
                        <p className="text-zinc-400 text-sm mb-8">Select your preferred local currency for the whole app.</p>

                        <div className="grid grid-cols-2 gap-3 mb-8 max-h-[60vh] overflow-y-auto pr-2">
                            {[
                                { code: 'INR', label: 'Indian Rupee (₹)' },
                                { code: 'USD', label: 'US Dollar ($)' },
                                { code: 'EUR', label: 'Euro (€)' },
                                { code: 'GBP', label: 'British Pound (£)' },
                                { code: 'AED', label: 'UAE Dirham' },
                                { code: 'SGD', label: 'Singapore Dollar' },
                                { code: 'CAD', label: 'Canadian Dollar' },
                                { code: 'AUD', label: 'Australian Dollar' },
                            ].map((cur) => (
                                <button
                                    key={cur.code}
                                    onClick={async () => {
                                        setSaving(true);
                                        try {
                                            await updateUserDetails(profile.uid, { preferredCurrency: cur.code });
                                            setShowCurrencyModal(false);
                                        } catch (err) {
                                            console.error(err);
                                        } finally {
                                            setSaving(false);
                                        }
                                    }}
                                    className={`p-4 rounded-2xl border-2 transition-all text-left ${profile.preferredCurrency === cur.code
                                            ? 'border-[#E5D5B3] bg-[#E5D5B3]/5'
                                            : 'border-zinc-100 bg-zinc-50'
                                        }`}
                                >
                                    <p className={`font-black text-[10px] uppercase tracking-wider ${profile.preferredCurrency === cur.code ? 'text-[#D4AF37]' : 'text-zinc-400'
                                        }`}>
                                        {cur.code}
                                    </p>
                                    <p className="text-zinc-900 font-bold text-sm mt-1">{cur.label}</p>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Profile;
