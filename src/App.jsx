
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toPng } from 'html-to-image';
import { QRCodeSVG } from 'qrcode.react';
import { isConfigured, supabase } from './lib/supabase.js';
import { aggregateItems, calculateBills, cleanItemLabel, getParticipants, money, normalizeItemName } from './lib/billing.js';

const dateLabel = value => value ? new Date(value).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : 'بدون موعد إغلاق';
const shortTime = value => value ? new Date(value).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
const isRoundOpen = round => round?.status === 'open' && (!round.deadline || new Date(round.deadline).getTime() > Date.now());
const publicUrl = token => `${window.location.origin}${window.location.pathname}?token=${encodeURIComponent(token)}`;

const toItemsPayload = items => items.filter(item => item.description?.trim()).map(item => ({
  description: item.description.trim(),
  quantity: Math.max(1, Math.min(99, Number(item.quantity) || 1)),
  kind: item.kind === 'shared' ? 'shared' : 'individual',
  participants: item.kind === 'shared' ? [...new Set((item.participants || []).map(name => name.trim()).filter(Boolean))] : []
}));

const buildFormItems = (items, owner) => toItemsPayload(items.map(item => ({
  ...item,
  participants: item.kind === 'shared'
    ? [owner, ...(item.participantsText || '').split(/[،,]/).map(name => name.trim()).filter(Boolean)]
    : []
})));

const hasIncompleteSharedItem = items => items.some(item => item.kind === 'shared' && item.participants.length < 2);
const hasTooManyParticipants = items => items.some(item => item.kind === 'shared' && item.participants.length > 20);

function Logo() {
  return <div className="brand"><img src="/forks-up-512.png" alt="Forks Up"/><div><b>Forks Up</b><small>United We Eat. Divided We Pay.</small></div></div>;
}

function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(
    new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery'
  );
  const [rounds, setRounds] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [roundData, setRoundData] = useState(null);
  const [tab, setTab] = useState('orders');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [routeToken, setRouteToken] = useState(new URLSearchParams(window.location.search).get('token'));
  const [resourceBusy, setResourceBusy] = useState(false);
  const [roundSearch, setRoundSearch] = useState('');
  const [restaurants, setRestaurants] = useState([]);



  const flash = useCallback(message => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 3000);
  }, []);

  const report = useCallback(err => {
    console.error(err);
    setError(err?.message || 'حدث خطأ غير متوقع. حاول مرة أخرى.');
  }, []);

  useEffect(() => {
    if (!isConfigured) {
      setAuthReady(true);
      return;
    }

    let mounted = true;

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;

      setSession(nextSession);

      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
      if (event === 'SIGNED_OUT') setRecoveryMode(false);
    });

    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!mounted) return;
      if (sessionError) console.error(sessionError);
      setSession(data?.session || null);
      setAuthReady(true);
    }).catch(err => {
      console.error(err);
      if (mounted) setAuthReady(true);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const handle = () => {
      setRouteToken(new URLSearchParams(window.location.search).get('token'));
      setRecoveryMode(new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery');
    };

    window.addEventListener('popstate', handle);
    return () => window.removeEventListener('popstate', handle);
  }, []);

  const loadRestaurants = useCallback(async () => {
    const { data, error: queryError } = await supabase.from('restaurants').select('id,name,category').order('name');
    if (queryError) throw queryError;
    if ((!data || !data.length) && session?.user?.id) {
      const { data: seeded, error: seedError } = await supabase.from('restaurants').insert({ created_by: session.user.id, name: 'أسماك الحوت', category: 'مأكولات بحرية' }).select('id,name,category').single();
      if (seedError) throw seedError;
      setRestaurants([seeded]);
      return;
    }
    setRestaurants(data || []);
  }, [session?.user?.id]);

  const loadRounds = useCallback(async () => {
    if (!session?.user?.id) return;

    const { data, error: queryError } = await supabase
      .from('rounds')
      .select('*')
      .eq('created_by', session.user.id)
      .order('created_at', { ascending: false });

    if (queryError) throw queryError;

    setRounds(data || []);
    setActiveId(current =>
      current && data?.some(round => round.id === current)
        ? current
        : data?.[0]?.id || null
    );
  }, [session?.user?.id]);

  const loadRound = useCallback(async id => {
    if (!id) {
      setRoundData(null);
      return;
    }

    const [roundResult, orderResult, priceResult, logResult] = await Promise.all([
      supabase.from('rounds').select('*').eq('id', id).maybeSingle(),
      supabase.from('orders').select('*, order_items(*)').eq('round_id', id).order('created_at', { ascending: true }),
      supabase.from('item_prices').select('*').eq('round_id', id),
      supabase.from('edit_logs').select('*').eq('round_id', id).order('created_at', { ascending: false }).limit(100)
    ]);

    if (!roundResult.data && !roundResult.error) {
      setRoundData(null);
      return;
    }

    for (const result of [roundResult, orderResult, priceResult, logResult]) {
      if (result.error) throw result.error;
    }

    const restaurantId = roundResult.data.restaurant_id;
    const [menuResult, requestResult, employeeResult] = await Promise.all([
      restaurantId ? supabase.from('restaurant_menu_items').select('*').eq('restaurant_id', restaurantId).eq('active', true).order('name') : Promise.resolve({ data: [], error: null }),
      restaurantId ? supabase.from('menu_item_requests').select('*').eq('round_id', id).order('created_at', { ascending: true }) : Promise.resolve({ data: [], error: null }),
      supabase.from('employee_directory').select('id,employee_name').order('employee_name')
    ]);
    for (const result of [menuResult, requestResult, employeeResult]) if (result.error) throw result.error;

    const priceMap = Object.fromEntries(
      (priceResult.data || []).map(row => [row.normalized_name, Number(row.unit_price)])
    );

    setRoundData({
      ...roundResult.data,
      orders: orderResult.data || [],
      prices: priceMap,
      priceRows: priceResult.data || [],
      logs: logResult.data || [],
      menuItems: menuResult.data || [],
      menuRequests: requestResult.data || [],
      employeeNames: [...new Set([...(employeeResult.data || []).map(row => row.employee_name), ...getParticipants(orderResult.data || [])])].sort((a,b) => a.localeCompare(b,'ar'))
    });
  }, []);

  useEffect(() => {
    if (session) {
      loadRounds().catch(report);
      loadRestaurants().catch(report);
    } else {
      setRounds([]);
      setRoundData(null);
    }
  }, [session, loadRounds, loadRestaurants, report]);

  useEffect(() => {
    if (session && activeId) {
      loadRound(activeId).catch(report);
    } else {
      setRoundData(null);
    }
  }, [session, activeId, loadRound, report]);

  useEffect(() => {
    if (!session || !activeId) return;

    const channel = supabase.channel(`round-${activeId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `round_id=eq.${activeId}` }, payload => {
        loadRound(activeId).catch(report);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `id=eq.${activeId}` }, () => {
        loadRounds().catch(report);
        loadRound(activeId).catch(report);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'item_prices', filter: `round_id=eq.${activeId}` }, () => loadRound(activeId).catch(report))
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session, activeId, loadRound, loadRounds, report]);

  const exportBackup = async () => {
    setResourceBusy(true);
    try {
      const tables = ['rounds','orders','order_items','item_prices','edit_logs',];
      const data = {};
      for (const table of tables) {
        const { data: rows, error: queryError } = await supabase.from(table).select('*');
        if (queryError) throw queryError;
        data[table] = rows || [];
      }
      const backup = { app: 'Forks Up', version: 1, exported_at: new Date().toISOString(), data };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Forks-Up-Backup-${new Date().toISOString().slice(0,10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      flash('تم تنزيل النسخة الاحتياطية');
    } catch (err) { report(err); }
    finally { setResourceBusy(false); }
  };

  const importBackup = async file => {
    if (!file) return;
    if (!window.confirm('سيتم دمج بيانات النسخة الاحتياطية مع بيانات حسابك الحالية. هل تريد المتابعة؟')) return;
    setResourceBusy(true);
    try {
      const backup = JSON.parse(await file.text());
      if (backup?.app !== 'Forks Up' || backup?.version !== 1 || !backup?.data) throw new Error('ملف النسخة الاحتياطية غير صالح.');
      const tables = ['rounds','orders','order_items','item_prices','edit_logs',];
      for (const table of tables) {
        if (!Array.isArray(backup.data[table] || [])) throw new Error(`بيانات ${table} غير صالحة.`);
      }
      const { error: restoreError } = await supabase.rpc('admin_restore_backup', { p_backup: backup.data });
      if (restoreError) throw restoreError;
      await loadRounds();
      if (activeId) await loadRound(activeId);
      flash('تم استيراد ودمج النسخة الاحتياطية');
    } catch (err) { report(err); }
    finally { setResourceBusy(false); }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setRecoveryMode(false);
  };

  const finishRecovery = () => {
    setRecoveryMode(false);
    setError('');
    window.history.replaceState({}, document.title, window.location.pathname);
  };

  const createRestaurant = async name => {
    const cleanName = name.trim();
    if (cleanName.length < 2) throw new Error('اكتب اسم المطعم بشكل صحيح.');
    const { data, error: insertError } = await supabase.from('restaurants').insert({ created_by: session.user.id, name: cleanName }).select('id,name,category').single();
    if (insertError) throw insertError;
    setRestaurants(old => [...old, data].sort((a,b) => a.name.localeCompare(b.name,'ar')));
    flash('تم حفظ المطعم');
    return data;
  };

  const createRound = async form => {
    setBusy(true);
    setError('');

    let createdRoundId = null;

    try {
      if (form.file && form.file.size > 10 * 1024 * 1024) {
        throw new Error('حجم المنيو يجب ألا يتجاوز 10 ميجابايت.');
      }

      if (form.file && !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(form.file.type)) {
        throw new Error('صيغة المنيو غير مدعومة. استخدم صورة JPG أو PNG أو WEBP أو ملف PDF.');
      }

      const { data, error: insertError } = await supabase.from('rounds').insert({
        created_by: session.user.id,
        title: form.title.trim(),
        food_type: form.foodType.trim(),
        restaurant_id: form.restaurantId || null,
        deadline: form.deadline || null,
        status: 'open'
      }).select().single();

      if (insertError) throw insertError;

      createdRoundId = data.id;

      if (form.file) {
        const safeName = form.file.name.replace(/[^\w.\-\u0600-\u06FF]/g, '_');
        const path = `${session.user.id}/${data.id}/${Date.now()}-${safeName}`;

        const { error: uploadError } = await supabase.storage
          .from('round-menus')
          .upload(path, form.file, { upsert: true, contentType: form.file.type });

        if (uploadError) throw uploadError;

        const { error: updateError } = await supabase
          .from('rounds')
          .update({ menu_path: path })
          .eq('id', data.id);

        if (updateError) throw updateError;
      }

      await loadRounds();
      setActiveId(data.id);
      setTab('orders');
      flash('تم إنشاء الجولة بنجاح');
      return true;
    } catch (err) {
      if (createdRoundId) {
        await supabase.from('rounds').delete().eq('id', createdRoundId);
      }
      report(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const duplicateRound = async () => {
    if (!roundData) return;
    const ok = window.confirm('إنشاء جولة جديدة بنفس نوع الطعام واسم الجولة، دون نسخ طلبات الموظفين؟');
    if (!ok) return;
    await createRound({
      foodType: roundData.food_type,
      title: roundData.title ? `نسخة من ${roundData.title}` : 'جولة مكررة',
      restaurantId: roundData.restaurant_id || '',
      deadline: null,
      file: null
    });
  };

  const updateRound = async patch => {
    if (!roundData) return;

    setBusy(true);
    setError('');

    try {
      const { error: updateError } = await supabase
        .from('rounds')
        .update(patch)
        .eq('id', roundData.id);

      if (updateError) throw updateError;

      await Promise.all([loadRounds(), loadRound(roundData.id)]);
      flash('تم حفظ التغييرات');
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  };

  const deleteRound = async () => {
    if (!roundData) return;
    const title = roundData.title || roundData.food_type || 'هذه الجولة';
    if (!window.confirm(`حذف "${title}" وجميع الطلبات والأسعار وسجل التعديلات المرتبط بها نهائيًا؟`)) return;
    if (!window.confirm('تأكيد أخير: لا يمكن التراجع عن حذف الجولة. هل تريد المتابعة؟')) return;

    setBusy(true);
    setError('');
    try {
      if (roundData.menu_path) {
        const { error: storageError } = await supabase.storage
          .from('round-menus')
          .remove([roundData.menu_path]);
        if (storageError) console.warn('تعذر حذف ملف المنيو:', storageError);
      }

      const { error: deleteError } = await supabase
        .from('rounds')
        .delete()
        .eq('id', roundData.id)
        .eq('created_by', session.user.id);
      if (deleteError) throw deleteError;

      setRoundData(null);
      setTab('orders');
      await loadRounds();
      flash('تم حذف الجولة وجميع بياناتها المرتبطة');
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  };

  const saveItemPrice = async (item, value) => {
    if (value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return;
    const { error: priceError } = await supabase
      .from('item_prices')
      .upsert({
        round_id: roundData.id,
        normalized_name: item.key,
        display_name: item.label,
        unit_price: Number(value)
      }, { onConflict: 'round_id,normalized_name' });
    if (priceError) {
      report(priceError);
      throw priceError;
    }
  };

  const saveOrder = async (order, next) => {
    setBusy(true);
    setError('');

    try {
      const { error: saveError } = await supabase.rpc('admin_save_order', {
        p_order_id: order.id,
        p_employee_name: next.employee_name,
        p_items: toItemsPayload(next.items)
      });

      if (saveError) throw saveError;

      await loadRound(roundData.id);
      flash('تم تعديل الطلب وتسجيل التعديل في السجل');
      return true;
    } catch (err) {
      report(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // إنشاء طلب جديد بواسطة المسؤول
  const createAdminOrder = async next => {
    if (!roundData) return false;

    setBusy(true);
    setError('');

    try {
      const { error: createError } = await supabase.rpc('admin_create_order', {
        p_round_id: roundData.id,
        p_employee_name: next.employee_name,
        p_items: toItemsPayload(next.items)
      });

      if (createError) {
        const message = createError.message || '';

        if (message.includes('DUPLICATE_EMPLOYEE_ORDER')) {
          throw new Error('يوجد طلب مسجل بهذا الاسم بالفعل في هذه الجولة.');
        }

        if (message.includes('ROUND_CLOSED')) {
          throw new Error('الجولة مغلقة أو انتهى موعد استقبال الطلبات.');
        }

        if (message.includes('SHARED_ITEM_NEEDS_PARTICIPANTS')) {
          throw new Error('الصنف المشترك يحتاج مشاركين اثنين على الأقل.');
        }

        throw createError;
      }

      await loadRound(roundData.id);
      flash('تم إضافة الشخص والطلب بنجاح');
      return true;
    } catch (err) {
      report(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const deleteOrder = async order => {
    if (!window.confirm(`حذف طلب ${order.employee_name} بالكامل؟`)) return;

    setBusy(true);
    setError('');

    try {
      const { error: deleteError } = await supabase.rpc('admin_delete_order', {
        p_order_id: order.id
      });

      if (deleteError) throw deleteError;

      await loadRound(roundData.id);
      flash('تم حذف الطلب وتسجيل العملية');
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  };

  if (!isConfigured) return <SetupScreen />;

  if (routeToken) {
    return <GuestPage
      token={routeToken}
      onBack={() => {
        history.pushState({}, '', window.location.pathname);
        setRouteToken(null);
      }}
    />;
  }

  if (!authReady) return <LoadingScreen />;

  if (recoveryMode) {
    return <ResetPasswordScreen onDone={finishRecovery} />;
  }

  if (!session) return <LoginScreen />;

  const participants = roundData ? getParticipants(roundData.orders) : [];
  const aggregate = roundData ? aggregateItems(roundData.orders) : [];
  const totalOrderedUnits = aggregate.reduce((sum, item) => sum + item.quantity, 0);
  const popularItem = [...aggregate].sort((a, b) => b.quantity - a.quantity)[0];

  return <div className="app-shell">
    <header className="topbar">
      <Logo />
      <div className="top-actions">
        <span className="hall-tag">HALL NO. 213</span>
        <button className="logout-btn" onClick={signOut}>تسجيل الخروج</button>
      </div>
    </header>

    <main className="container">
      <section className="welcome">
        <div>
          <p className="eyebrow">لوحة تحكم المسؤول</p>
          <h1>خلّينا نطلب حاجة حلوة.</h1>
          <p>أنشئ جولة، شارك الكود، واترك الباقي على Forks Up.</p>
        </div>
        <button className="primary" onClick={() => document.getElementById('create-round')?.showModal()}>＋ جولة جديدة</button>
      </section>

      {error && <div className="error-banner">
        <span>{error}</span>
        <button onClick={() => setError('')}>إغلاق</button>
      </div>}

      <CreateRoundDialog onCreate={createRound} onCreateRestaurant={createRestaurant} busy={busy} restaurants={restaurants} />

      <ParticipantsDialog participants={participants} />

      {!roundData ? <div className="empty card">
        <div className="empty-icon">🍽️</div>
        <h2>لسه مفيش جولات</h2>
        <p>ابدأ أول جولة طعام وشارك QR Code مع زملائك.</p>
        <button className="primary" onClick={() => document.getElementById('create-round')?.showModal()}>إنشاء أول جولة</button>
      </div> : <>
        <div className="section-heading">
          <div>
            <p className="eyebrow">الجولة الحالية</p>
            <h2>{roundData.food_type}</h2>
            {roundData.restaurant_id && <p className="muted">المطعم: {restaurants.find(item => item.id === roundData.restaurant_id)?.name || 'مطعم محدد'}</p>}
            <p className="muted">{roundData.title || 'جولة طلب الطعام'} · {dateLabel(roundData.created_at)}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className={`status ${isRoundOpen(roundData) ? 'open' : 'closed'}`}>
              {isRoundOpen(roundData) ? 'مفتوحة للطلبات' : 'مغلقة'}
            </span>
            <button type="button" className="text-btn" disabled={busy} onClick={duplicateRound}>تكرار الجولة</button>
            <button type="button" className="text-btn danger" disabled={busy} onClick={deleteRound}>حذف الجولة</button>
          </div>
        </div>

        <div className="summary-grid">
          <Stat label="عدد الطلبات" value={roundData.orders.length} />
          <Stat
            label="عدد المشاركين"
            value={participants.length}
            onClick={() => document.getElementById('participants-dialog')?.showModal()}
          />
          <Stat label="موعد الإغلاق" value={roundData.deadline ? dateLabel(roundData.deadline) : 'مفتوحة'} />
          <Stat label="إجمالي وحدات الأصناف" value={totalOrderedUnits} />
          <Stat label="الأكثر طلبًا" value={popularItem ? `${popularItem.label} · ${popularItem.quantity}` : 'لا توجد أصناف'} />
        </div>

        <div className="tabs">
          <button className={tab === 'orders' ? 'selected' : ''} onClick={() => setTab('orders')}>الطلبات</button>
          <button className={tab === 'menu' ? 'selected' : ''} onClick={() => setTab('menu')}>منيو المطعم</button>
          <button className={tab === 'restaurant' ? 'selected' : ''} onClick={() => setTab('restaurant')}>تجميع طلب المطعم</button>
          <button className={tab === 'invoice' ? 'selected' : ''} onClick={() => setTab('invoice')}>الفاتورة والحسابات</button>
          <button className={tab === 'share' ? 'selected' : ''} onClick={() => setTab('share')}>مشاركة الجولة</button>
          <button className={tab === 'history' ? 'selected' : ''} onClick={() => setTab('history')}>سجل التعديلات</button>
        </div>

        {tab === 'orders' && <OrdersPanel
          round={roundData}
          busy={busy}
          onSave={saveOrder}
          onDelete={deleteOrder}
          onCreate={createAdminOrder}
          onToggle={() => updateRound({ status: roundData.status === 'open' ? 'closed' : 'open' })}
        />}

        {tab === 'menu' && <RestaurantMenuPanel round={roundData} restaurants={restaurants} onAssign={id => updateRound({ restaurant_id: id })} busy={busy}
          onAdd={async textValue => {
            const names = [...new Set(textValue.split(/\r?\n/).map(name => name.trim()).filter(Boolean))];
            if (!names.length) return;
            const rows = names.map(name => ({ restaurant_id: roundData.restaurant_id, name, normalized_name: normalizeItemName(name), active: true }));
            const { error: insertError } = await supabase.from('restaurant_menu_items').upsert(rows, { onConflict: 'restaurant_id,normalized_name', ignoreDuplicates: true });
            if (insertError) throw insertError;
            await loadRound(roundData.id);
            flash('تمت إضافة الصنف إلى منيو المطعم');
          }}
          onImportRoundItems={async () => {
            const names = [...new Set((roundData.orders || []).flatMap(order => order.order_items || []).map(item => item.description?.trim()).filter(Boolean))];
            if (!names.length) throw new Error('لا توجد أصناف في طلبات هذه الجولة لاستخراجها.');
            const rows = names.map(name => ({ restaurant_id: roundData.restaurant_id, name, normalized_name: normalizeItemName(name), active: true }));
            const { error: importError } = await supabase.from('restaurant_menu_items').upsert(rows, { onConflict: 'restaurant_id,normalized_name', ignoreDuplicates: true });
            if (importError) throw importError;
            await loadRound(roundData.id);
            flash(`تم استخراج ${names.length} صنفاً من طلبات الجولة وإضافتها للمنيو`);
          }}
          onApprove={async request => {
            const { error: insertError } = await supabase.from('restaurant_menu_items').upsert({ restaurant_id: request.restaurant_id, name: request.requested_name, normalized_name: request.normalized_name, active: true }, { onConflict: 'restaurant_id,normalized_name' });
            if (insertError) throw insertError;
            const { error: deleteError } = await supabase.from('menu_item_requests').delete().eq('id', request.id);
            if (deleteError) throw deleteError;
            await loadRound(roundData.id);
            flash('تم اعتماد الصنف وإضافته للمنيو');
          }}
          onDismiss={async request => {
            const { error: deleteError } = await supabase.from('menu_item_requests').delete().eq('id', request.id);
            if (deleteError) throw deleteError;
            await loadRound(roundData.id);
          }}
        />}
        {tab === 'restaurant' && <RestaurantOrderSummary round={roundData} />}

        {tab === 'invoice' && <InvoicePanel
          round={roundData}
          busy={busy}
          onPriceSave={saveItemPrice}
          onSave={async (prices, delivery) => {
            setBusy(true);
            setError('');

            try {
              const rows = aggregateItems(roundData.orders).map(item => ({
                round_id: roundData.id,
                normalized_name: item.key,
                display_name: item.label,
                unit_price: Math.max(0, Number(prices[item.key]) || 0)
              }));

              if (rows.length) {
                const { error: priceError } = await supabase
                  .from('item_prices')
                  .upsert(rows, { onConflict: 'round_id,normalized_name' });

                if (priceError) throw priceError;
              }

              const { error: feeError } = await supabase
                .from('rounds')
                .update({ delivery_fee: Math.max(0, Number(delivery) || 0) })
                .eq('id', roundData.id);

              if (feeError) throw feeError;

              await loadRound(roundData.id);
              flash('تم حفظ الفاتورة والحسابات');
            } catch (err) {
              report(err);
            } finally {
              setBusy(false);
            }
          }}
        />}

        {tab === 'share' && <SharePanel round={roundData} />}
        {tab === 'history' && <HistoryPanel logs={roundData.logs} />}

        <div className="round-switch">
          <span>أرشيف الجولات السابقة والحالية</span>
          <input value={roundSearch} onChange={event => setRoundSearch(event.target.value)} placeholder="ابحث بنوع الطعام أو اسم الجولة" aria-label="البحث في أرشيف الجولات" />
          <select value={roundData.id} onChange={event => setActiveId(event.target.value)}>
            {rounds.filter(round => `${round.food_type} ${round.title || ''} ${new Date(round.created_at).toLocaleDateString('ar-EG')}`.toLocaleLowerCase('ar').includes(roundSearch.trim().toLocaleLowerCase('ar'))).map(round => <option key={round.id} value={round.id}>
              {round.food_type} — {round.title || 'جولة'} — {new Date(round.created_at).toLocaleDateString('ar-EG')}
            </option>)}
          </select>
        </div>
      </>}

      <section className="panel card" style={{ marginTop: 24 }}>
        <div className="panel-title"><div><h3>النسخ الاحتياطي</h3><p className="muted">تصدير بيانات جولات Hall No. 213 أو استعادة نسخة محفوظة.</p></div></div>
        <div className="tools-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 16 }}>
          <BackupPanel busy={resourceBusy} onExport={exportBackup} onImport={importBackup} />
        </div>
      </section>

      <footer>Forks Up <span>•</span> Hall No. 213 <span>•</span> Built for eating together.</footer>
    </main>

    {busy && <div className="busy-pill">جارٍ الحفظ...</div>}
    {notice && <div className="toast">✓ {notice}</div>}
  </div>;
}

function SetupScreen() {
  return <div className="center-screen">
    <div className="setup-card card">
      <Logo />
      <h1>إعداد الاتصال الآمن</h1>
      <p>المشروع جاهز للاتصال بقاعدة البيانات. أضف رابط مشروع Supabase والمفتاح العام في ملف <code>.env</code> ثم أعد النشر.</p>
      <pre>VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co<br />VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_KEY</pre>
      <p className="muted">لا تضع مفتاح service_role في التطبيق أو في GitHub.</p>
    </div>
  </div>;
}

function LoadingScreen() {
  return <div className="center-screen"><div className="loader" /><span>جارٍ تحميل Forks Up...</span></div>;
}

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');

    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });

      if (authError) setError('البريد الإلكتروني أو كلمة المرور غير صحيحة، أو تعذر تسجيل الدخول.');
    } catch {
      setError('تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  const recover = async () => {
    if (!email.trim()) {
      setError('اكتب بريدك الإلكتروني أولاً ثم اضغط نسيت كلمة المرور.');
      return;
    }

    setBusy(true);
    setError('');
    setMessage('');

    try {
      const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo: window.location.origin }
      );

      if (recoveryError) throw recoveryError;

      setMessage('تم إرسال رابط الاستعادة إذا كان البريد مسجلاً. افتح الرسالة على هذا الجهاز.');
    } catch (err) {
      setError(err.message || 'تعذر إرسال رسالة الاستعادة. حاول لاحقاً.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="center-screen">
    <form className="login-card card" onSubmit={submit}>
      <Logo />
      <p className="eyebrow">دخول المسؤول</p>
      <h1>أهلاً بعودتك</h1>
      <p className="muted">سجّل الدخول لإدارة جولات الطعام والطلبات.</p>

      <label>البريد الإلكتروني
        <input type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@example.com" />
      </label>

      <label>كلمة المرور
        <input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
      </label>

      {error && <div className="inline-error">{error}</div>}
      {message && <div className="success-message">{message}</div>}

      <button className="primary full" disabled={busy}>
        {busy ? 'جارٍ التنفيذ...' : 'تسجيل الدخول'}
      </button>

      <button type="button" className="text-btn" disabled={busy} onClick={recover}>نسيت كلمة المرور؟</button>
      <small className="muted">حساب المسؤول يُنشأ من لوحة Supabase، ولا يوجد تسجيل مفتوح للموظفين.</small>
    </form>
  </div>;
}

function ResetPasswordScreen({ onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const submit = async event => {
    event.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('كلمة المرور يجب ألا تقل عن 8 أحرف.');
      return;
    }

    if (password !== confirm) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }

    setBusy(true);

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setSuccess(true);
    } catch (err) {
      setError(err.message || 'تعذر تحديث كلمة المرور. قد يكون رابط الاستعادة منتهي الصلاحية.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="center-screen">
    <form className="login-card card" onSubmit={submit}>
      <Logo />
      <p className="eyebrow">استعادة الحساب</p>
      <h1>تعيين كلمة مرور جديدة</h1>

      {success ? <>
        <div className="success-message">تم تحديث كلمة المرور بنجاح. يمكنك الآن تسجيل الدخول.</div>
        <button type="button" className="primary full" onClick={onDone}>العودة إلى تسجيل الدخول</button>
      </> : <>
        <p className="muted">اختر كلمة مرور جديدة لا تقل عن 8 أحرف.</p>

        <label>كلمة المرور الجديدة
          <input type="password" required minLength="8" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>

        <label>تأكيد كلمة المرور
          <input type="password" required minLength="8" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
        </label>

        {error && <div className="inline-error">{error}</div>}
        <button className="primary full" disabled={busy}>{busy ? 'جارٍ الحفظ...' : 'حفظ كلمة المرور الجديدة'}</button>
      </>}
    </form>
  </div>;
}

// بطاقة إحصائية قابلة للضغط عند وجود onClick
function Stat({ label, value, onClick }) {
  if (onClick) {
    return <button
      type="button"
      className="stat card"
      onClick={onClick}
      style={{ cursor: 'pointer', textAlign: 'inherit', font: 'inherit', width: '100%' }}
      title="اضغط لعرض أسماء المشاركين"
    >
      <span>{label}</span>
      <b>{value}</b>
      <small style={{ display: 'block', marginTop: 5, opacity: 0.7 }}>اضغط لعرض الأسماء</small>
    </button>;
  }

  return <div className="stat card"><span>{label}</span><b>{value}</b></div>;
}

// نافذة عرض أسماء المشاركين
function ParticipantsDialog({ participants }) {
  return <dialog id="participants-dialog" className="dialog card">
    <div className="modal-head">
      <div>
        <h2>المشاركون في الجولة</h2>
        <small className="muted">إجمالي المشاركين: {participants.length}</small>
      </div>
      <button type="button" className="icon-btn" onClick={() => document.getElementById('participants-dialog')?.close()}>×</button>
    </div>

    {!participants.length ? (
      <div className="empty-inline">لا يوجد مشاركون حتى الآن.</div>
    ) : (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 16 }}>
        {participants.map((person, index) => (
          <div key={person} style={{
            padding: '12px',
            borderRadius: 12,
            background: 'var(--cream, #f7f3e9)',
            border: '1px solid #e6dfd0',
            display: 'flex',
            alignItems: 'center',
            gap: 9
          }}>
            <span style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#174b3b',
              color: '#fff',
              flexShrink: 0,
              fontSize: 13
            }}>{index + 1}</span>
            <b>{person}</b>
          </div>
        ))}
      </div>
    )}

    <div className="modal-actions">
      <button type="button" className="primary" onClick={() => document.getElementById('participants-dialog')?.close()}>إغلاق</button>
    </div>
  </dialog>;
}

function CreateRoundDialog({ onCreate, onCreateRestaurant, busy, restaurants = [] }) {
  const [foodType, setFoodType] = useState('');
  const [restaurantId, setRestaurantId] = useState('');
  const [newRestaurantName, setNewRestaurantName] = useState('');
  const [restaurantError, setRestaurantError] = useState('');
  useEffect(() => {
    if (!restaurantId && restaurants.length) {
      const seafood = restaurants.find(item => item.name.includes('أسماك الحوت'));
      setRestaurantId((seafood || restaurants[0]).id);
    }
  }, [restaurants, restaurantId]);
  const [title, setTitle] = useState('');
  const [deadline, setDeadline] = useState('');
  const [file, setFile] = useState(null);

  const submit = async event => {
    event.preventDefault();

    const created = await onCreate({
      foodType,
      restaurantId,
      title,
      deadline: deadline ? new Date(deadline).toISOString() : null,
      file
    });

    if (created) {
      setFoodType('');
      setTitle('');
      setDeadline('');
      setFile(null);
      document.getElementById('round-menu-file').value = '';
      document.getElementById('create-round')?.close();
    }
  };

  return <dialog id="create-round" className="dialog card">
    <form onSubmit={submit}>
      <div className="modal-head">
        <h2>إنشاء جولة جديدة</h2>
        <button type="button" className="icon-btn" onClick={() => document.getElementById('create-round')?.close()}>×</button>
      </div>

      <label>المطعم</label>
      <select value={restaurantId} onChange={e => setRestaurantId(e.target.value)}>
        <option value="">بدون مطعم محفوظ</option>
        {restaurants.map(restaurant => <option key={restaurant.id} value={restaurant.id}>{restaurant.name} {restaurant.category ? `— ${restaurant.category}` : ''}</option>)}
      </select>
      <div style={{display:'flex',gap:8,alignItems:'center',marginTop:8}}>
        <input value={newRestaurantName} onChange={e=>setNewRestaurantName(e.target.value)} placeholder="إضافة مطعم جديد" maxLength="120" />
        <button type="button" className="secondary small-btn" onClick={async()=>{try{setRestaurantError('');const created=await onCreateRestaurant(newRestaurantName);setRestaurantId(created.id);setNewRestaurantName('');}catch(err){setRestaurantError(err.message || 'تعذر إضافة المطعم.');}}}>إضافة</button>
      </div>
      {restaurantError && <small className="inline-error">{restaurantError}</small>}
      <label>نوع الطعام</label>
      <input required maxLength="80" placeholder="مثلاً: مأكولات بحرية، برجر، بيتزا..." value={foodType} onChange={e => setFoodType(e.target.value)} />

      <label>اسم اختياري للجولة</label>
      <input maxLength="100" placeholder="مثلاً: غداء يوم الثلاثاء" value={title} onChange={e => setTitle(e.target.value)} />

      <label>موعد إغلاق الطلبات</label>
      <input type="datetime-local" min={new Date().toISOString().slice(0, 16)} value={deadline} onChange={e => setDeadline(e.target.value)} />

      <label>منيو المطعم (اختياري — صورة أو PDF)</label>
      <input id="round-menu-file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => setFile(e.target.files?.[0] || null)} />
      <small className="hint">الحد الأقصى 10 ميجابايت.</small>

      <div className="modal-actions">
        <button type="button" className="secondary" onClick={() => document.getElementById('create-round')?.close()}>إلغاء</button>
        <button className="primary" disabled={busy}>إنشاء الجولة</button>
      </div>
    </form>
  </dialog>;
}

// نافذة إضافة شخص وطلبه مباشرة بواسطة المسؤول
function AdminCreateOrderDialog({ round, busy, onCreate }) {
  const employeeNames = [...new Set([...(round.employeeNames || []), ...getParticipants(round.orders || [])])];
  const emptyItem = () => ({
    key: crypto.randomUUID(),
    description: '',
    quantity: 1,
    kind: 'individual',
    participantsText: ''
  });

  const [name, setName] = useState('');
  const [items, setItems] = useState([emptyItem()]);
  const [localError, setLocalError] = useState('');

  const patchItem = (key, patch) => {
    setItems(old => old.map(item => item.key === key ? { ...item, ...patch } : item));
  };

  const reset = () => {
    setName('');
    setItems([emptyItem()]);
    setLocalError('');
  };

  const submit = async event => {
    event.preventDefault();
    setLocalError('');

    const cleanName = name.trim();

    if (cleanName.length < 2) {
      setLocalError('اكتب اسم الشخص بشكل صحيح.');
      return;
    }

    const payload = buildFormItems(items, cleanName);

    if (!payload.length) {
      setLocalError('أضف صنفاً واحداً على الأقل.');
      return;
    }

    if (hasIncompleteSharedItem(payload)) {
      setLocalError('الصنف المشترك يحتاج اسم شخص آخر على الأقل غير صاحب الطلب.');
      return;
    }

    if (hasTooManyParticipants(payload)) {
      setLocalError('الحد الأقصى للمشاركين في الصنف الواحد هو 20 شخصاً.');
      return;
    }

    const success = await onCreate({
      employee_name: cleanName,
      items: payload
    });

    if (success) {
      reset();
      document.getElementById('admin-create-order')?.close();
    }
  };

  return <dialog id="admin-create-order" className="dialog card">
    <form onSubmit={submit}>
      <div className="modal-head">
        <div>
          <h2>إضافة شخص وطلبه</h2>
          <small className="muted">{round.food_type} · تسجيل مباشر بواسطة المسؤول</small>
        </div>
        <button type="button" className="icon-btn" onClick={() => document.getElementById('admin-create-order')?.close()}>×</button>
      </div>

      <label>اسم الشخص</label>
      <input
        required
        minLength="2"
        maxLength="100"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="اكتب اسم الشخص"
        list="forks-up-employee-list"
      />
      <datalist id="forks-up-employee-list">
        {employeeNames.map(name => <option key={name} value={name} />)}
      </datalist>

      <div className="form-divider" />
      <div className="items-title">
        <b>الأصناف المطلوبة</b>
        <small>أضف أصناف هذا الشخص</small>
      </div>

      {items.map((item, index) => (
        <div className="guest-item" key={item.key}>
          <div className="item-top">
            <b>صنف {index + 1}</b>
            {items.length > 1 && (
              <button type="button" className="remove-link" onClick={() => setItems(old => old.filter(x => x.key !== item.key))}>حذف</button>
            )}
          </div>

          <input
            required
            maxLength="180"
            value={item.description}
            onChange={e => patchItem(item.key, { description: e.target.value })}
            placeholder="مثلاً: تشيز برجر دابل، بطاطس..."
          />
          <div className="item-controls">
            <label>الكمية
              <input
                type="number"
                min="1"
                max="99"
                value={item.quantity}
                onChange={e => patchItem(item.key, { quantity: e.target.value })}
              />
            </label>

            <label>نوع الصنف
              <select
                value={item.kind}
                onChange={e => patchItem(item.key, { kind: e.target.value })}
              >
                <option value="individual">فردي — على صاحب الطلب</option>
                <option value="shared">مشترك — نتقاسمه بالتساوي</option>
              </select>
            </label>
          </div>

          {item.kind === 'shared' && <div className="participant-picker" style={{display:"grid",gap:8,padding:10,border:"1px solid var(--line,#e6dfd0)",borderRadius:10}}><b>اختر المشاركين معه</b>
            {employeeNames.filter(person => person !== name.trim()).map(person => {
              const selected = (item.participantsText || '').split(/[،,]/).map(x => x.trim()).includes(person);
              return <label key={person}><input type="checkbox" checked={selected} onChange={e => {
                const selectedNames = (item.participantsText || '').split(/[،,]/).map(x => x.trim()).filter(Boolean);
                const next = e.target.checked ? [...selectedNames, person] : selectedNames.filter(x => x !== person);
                patchItem(item.key, { participantsText: next.join('، ') });
              }} /> {person}</label>;
            })}
            <small className="hint">اسم صاحب الطلب سيُضاف تلقائياً. الأسماء مأخوذة من الطلبات السابقة.</small>
          </div>}
        </div>
      ))}

      <button
        type="button"
        className="add-item"
        onClick={() => setItems(old => [...old, emptyItem()])}
      >＋ إضافة صنف آخر</button>

      {localError && <div className="inline-error">{localError}</div>}

      <div className="modal-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => document.getElementById('admin-create-order')?.close()}
        >إلغاء</button>

        <button className="primary" disabled={busy}>
          {busy ? 'جارٍ تسجيل الطلب...' : 'حفظ الشخص والطلب'}
        </button>
      </div>
    </form>
  </dialog>;
}

function GuestPage({ token, onBack }) {
  const [round, setRound] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [items, setItems] = useState([{ key: crypto.randomUUID(), description: '', quantity: 1, kind: 'individual', participantsText: '', customRequest: false }]);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;

    supabase.rpc('get_public_round', { p_token: token }).then(({ data, error: queryError }) => {
      if (!live) return;
      if (queryError) setError('تعذر تحميل الجولة. تحقق من الاتصال وحاول مرة أخرى.');
      setRound(data || null);
      setLoading(false);
    }).catch(() => {
      if (live) {
        setError('تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.');
        setLoading(false);
      }
    });

    return () => { live = false; };
  }, [token]);

  const menuUrl = round?.menu_path
    ? supabase.storage.from('round-menus').getPublicUrl(round.menu_path).data.publicUrl
    : null;

  const closed = !round || round.status !== 'open' ||
    (round.deadline && new Date(round.deadline).getTime() <= Date.now());

  const patchItem = (key, patch) =>
    setItems(old => old.map(item => item.key === key ? { ...item, ...patch } : item));

  const submit = async event => {
    event.preventDefault();
    setError('');

    const payload = buildFormItems(items, name.trim());

    if (items.some(item => item.customRequest)) {
      setError('أرسل طلب إضافة الصنف وانتظر اعتماد المسؤول، ثم حدّث الصفحة واختره من المنيو.');
      return;
    }

    if (!name.trim() || name.trim().length < 2) {
      setError('اكتب اسمك بشكل صحيح.');
      return;
    }

    if (!payload.length) {
      setError('أضف صنفاً واحداً على الأقل.');
      return;
    }

    if (hasIncompleteSharedItem(payload)) {
      setError('الصنف المشترك يحتاج اسم شخص آخر على الأقل غيرك.');
      return;
    }

    if (hasTooManyParticipants(payload)) {
      setError('الحد الأقصى للمشاركين في الصنف الواحد هو 20 شخصاً.');
      return;
    }

    setBusy(true);

    try {
      const { error: submitError } = await supabase.rpc('submit_public_order', {
        p_token: token,
        p_employee_name: name.trim(),
        p_items: payload
      });

      if (submitError) {
        const message = submitError.message || '';

        setError(
          message.includes('ROUND_CLOSED') ? 'انتهى استقبال الطلبات لهذه الجولة.' :
          message.includes('DUPLICATE_EMPLOYEE_ORDER') ? 'يوجد طلب مسجل بهذا الاسم بالفعل. تواصل مع المسؤول إذا أردت تعديله.' :
          message.includes('INVALID_EMPLOYEE_NAME') ? 'اكتب اسمك بشكل صحيح.' :
          'تعذر إرسال الطلب. حاول مرة أخرى أو تواصل مع المسؤول.'
        );

        return;
      }

      setSent(true);
    } catch {
      setError('تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="guest-wrap"><div className="guest-card card"><LoadingScreen /></div></div>;
  }

  if (sent) {
    return <div className="guest-wrap">
      <div className="guest-brand"><Logo /><span>HALL NO. 213</span></div>
      <div className="guest-card card success-card">
        <div className="success-icon">✓</div>
        <h1>طلبك وصل!</h1>
        <p>تم تسجيل طلبك بنجاح. تقدر تقفل الصفحة دلوقتي.</p>
      </div>
      <p className="guest-foot">United We Eat. Divided We Pay.</p>
    </div>;
  }

  return <div className="guest-wrap">
    <div className="guest-brand"><Logo /><span>HALL NO. 213</span></div>

    <div className="guest-card card">
      {!round || closed ? <>
        <div className="closed-icon">🔒</div>
        <h1>{round ? 'الجولة مغلقة' : 'الرابط غير صالح أو انتهت صلاحيته'}</h1>
        <p className="muted">{error || (round ? 'المسؤول أغلق استقبال الطلبات أو انتهى موعد التسجيل.' : 'تأكد من الرابط أو اطلب رابط الجولة الجديد من المسؤول.')}</p>
      </> : <>
        <p className="eyebrow">طلب جديد · {round.food_type}</p>
        <h1>يلا نطلب!</h1>
        <p className="muted">{round.title || 'سجّل طلبك، وحدد الأصناف الفردية والمشتركة.'}</p>

        {round.deadline && <p className="deadline-note">استقبال الطلبات حتى: {dateLabel(round.deadline)}</p>}
        {menuUrl && <a className="menu-link" href={menuUrl} target="_blank" rel="noreferrer">📎 عرض منيو المطعم</a>}

        <form onSubmit={submit}>
          <label>اسمك</label>
          <input required minLength="2" maxLength="100" value={name} onChange={e => setName(e.target.value)} placeholder="اكتب اسمك بالكامل" list="guest-employee-list" />
          <datalist id="guest-employee-list">{(round.employee_names || []).map(person => <option key={person} value={person} />)}</datalist>

          <div className="form-divider" />
          <div className="items-title"><b>الأصناف المطلوبة</b><small>أضف كل صنف في سطر مستقل</small></div>

          {items.map((item, index) => <div className="guest-item" key={item.key}>
            <div className="item-top">
              <b>صنف {index + 1}</b>
              {items.length > 1 && <button type="button" className="remove-link" onClick={() => setItems(old => old.filter(x => x.key !== item.key))}>حذف</button>}
            </div>

            {round.menu_items?.length ? <select required value={item.customRequest ? '__custom__' : item.description} onChange={e => e.target.value === '__custom__' ? patchItem(item.key, { description: '', customRequest: true }) : patchItem(item.key, { description: e.target.value, customRequest: false })}>
              <option value="">اختر صنفاً من المنيو</option>
              {round.menu_items.map(menuItem => <option key={menuItem.id} value={menuItem.name}>{menuItem.name}</option>)}
              <option value="__custom__">الصنف غير موجود — اكتب طلب إضافة</option>
            </select> : <input required value={item.description} maxLength="180" onChange={e => patchItem(item.key, { description: e.target.value })} placeholder="مثلاً: سمك مشوي، أرز صيادية..." />}
            {item.customRequest && <input required value={item.description} maxLength="180" placeholder="اكتب اسم الصنف المطلوب" onChange={e => patchItem(item.key, { description: e.target.value })} />}
            {item.customRequest && item.description.trim() && <button type="button" className="secondary small-btn" onClick={async () => {
              const { error: requestError } = await supabase.rpc('request_menu_item', { p_token: token, p_requested_name: item.description.trim(), p_employee_name: name.trim() });
              if (requestError) window.alert('تعذر إرسال طلب إضافة الصنف. حاول مرة أخرى.');
              else { patchItem(item.key, { requestSent: true }); window.alert('تم إرسال طلب الصنف للمسؤول للمراجعة. بعد اعتماده حدّث الصفحة لاختياره.'); }
            }} disabled={item.requestSent}>{item.requestSent ? 'تم إرسال الطلب للمراجعة' : 'طلب إضافة الصنف إلى المنيو'}</button>}

            <div className="item-controls">
              <label>الكمية
                <input type="number" min="1" max="99" value={item.quantity} onChange={e => patchItem(item.key, { quantity: e.target.value })} />
              </label>
              <label>نوع الصنف
                <select value={item.kind} onChange={e => patchItem(item.key, { kind: e.target.value })}>
                  <option value="individual">فردي — عليّ أنا</option>
                  <option value="shared">مشترك — نتقاسمه بالتساوي</option>
                </select>
              </label>
            </div>

            {item.kind === 'shared' && <div className="participant-picker" style={{display:"grid",gap:8,padding:10,border:"1px solid var(--line,#e6dfd0)",borderRadius:10}}><b>اختر المشاركين معك</b>
              {(round.employee_names || []).filter(person => person.trim() && person.trim() !== name.trim()).map(person => {
                const selected = (item.participantsText || '').split(/[،,]/).map(x => x.trim()).includes(person);
                return <label key={person}><input type="checkbox" checked={selected} onChange={e => {
                  const selectedNames = (item.participantsText || '').split(/[،,]/).map(x => x.trim()).filter(Boolean);
                  const next = e.target.checked ? [...selectedNames, person] : selectedNames.filter(x => x !== person);
                  patchItem(item.key, { participantsText: next.join('، ') });
                }} /> {person}</label>;
              })}
              <small className="hint">اسمك يُضاف تلقائياً. القائمة مستخرجة من الطلبات السابقة.</small>
            </div>}
          </div>)}

          <button type="button" className="add-item" onClick={() => setItems(old => [...old, { key: crypto.randomUUID(), description: '', quantity: 1, kind: 'individual', participantsText: '' }])}>＋ إضافة صنف آخر</button>

          {error && <div className="inline-error">{error}</div>}
          <button className="primary submit-order" disabled={busy}>{busy ? 'جارٍ إرسال الطلب...' : 'إرسال الطلب'}</button>
        </form>
      </>}
    </div>

    <p className="guest-foot">United We Eat. Divided We Pay.</p>
    <button className="back-link" onClick={onBack}>العودة إلى لوحة المسؤول</button>
  </div>;
}

function OrdersPanel({ round, busy, onSave, onDelete, onCreate, onToggle }) {
  // This panel is only rendered in the authenticated administrator dashboard.
  // Admin corrections remain available after public order intake closes.
  const canEdit = true;
  const canAdd = true;
  const expired = Boolean(round.deadline && new Date(round.deadline).getTime() <= Date.now());

  return <div className="panel card">
    <div className="panel-title">
      <div>
        <h3>طلبات الموظفين</h3>
        <p className="muted">{canEdit && isRoundOpen(round) ? 'يمكنك تعديل الطلبات وإضافة طلبات جديدة.' : 'استقبال الموظفين مغلق، لكن يمكنك بصفتك المسؤول تعديل الطلبات وإضافة أو حذف طلبات قبل اعتماد الفاتورة.'}</p>
      </div>
      <button className="secondary small-btn" disabled={busy || expired || false} onClick={onToggle}>
        {expired ? 'انتهى الموعد' : round.status === 'open' ? 'إغلاق الجولة' : 'إعادة فتح الجولة'}
      </button>
    </div>

    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '14px 0 18px' }}>
      <button
        type="button"
        className="primary"
        disabled={busy || !canAdd || !canEdit}
        onClick={() => document.getElementById('admin-create-order')?.showModal()}
      >＋ إضافة شخص وطلبه</button>
      {!isRoundOpen(round) && <small className="hint">التعديلات هنا متاحة للمسؤول فقط، ولن يُعاد فتح استقبال الموظفين.</small>}
    </div>

    <AdminCreateOrderDialog round={round} busy={busy} onCreate={onCreate} />

    {!round.orders.length
      ? <div className="empty-inline">لا توجد طلبات حتى الآن. يمكنك إضافة طلب بنفسك أو مشاركة QR Code ليبدأ الموظفون التسجيل.</div>
      : <div className="order-list">
          {round.orders.map(order => <OrderCard
            key={order.id}
            order={order}
            canEdit={canEdit}
            busy={busy}
            onSave={next => onSave(order, next)}
            onDelete={() => onDelete(order)}
            employeeNames={[...(round.employeeNames || []), ...getParticipants(round.orders || [])]}
          />)}
        </div>}
  </div>;
}

function OrderCard({ order, canEdit, busy, onSave, onDelete, employeeNames = [] }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <div className="order-card">
      <EditOrder
        order={order}
        employeeNames={employeeNames}
        busy={busy}
        onCancel={() => setEditing(false)}
        onSave={async next => {
          const saved = await onSave(next);
          if (saved !== false) setEditing(false);
        }}
      />
    </div>;
  }

  return <div className="order-card">
    <div className="order-head">
      <div><b>{order.employee_name}</b><small>{shortTime(order.created_at)}</small></div>
      <div className="order-actions">
        <button className="text-btn" disabled={!canEdit || busy} onClick={() => setEditing(true)}>تعديل</button>
        <button className="text-btn danger" disabled={!canEdit || busy} onClick={onDelete}>حذف</button>
      </div>
    </div>
    <ul className="order-items">
      {(order.order_items || []).map(item => <li key={item.id}>
        <span>{item.description} × {item.quantity}</span>
        <small>{item.kind === 'shared' ? `مشترك: ${(item.participants || []).join('، ')}` : 'فردي'}</small>
      </li>)}
    </ul>
  </div>;
}

function EditOrder({ order, employeeNames = [], busy, onCancel, onSave }) {
  const [name, setName] = useState(order.employee_name);
  const [items, setItems] = useState((order.order_items || []).map(item => ({
    ...item,
    participantsText: (item.participants || []).filter(person => person !== order.employee_name).join('، ')
  })));

  const patch = (id, changes) => setItems(old => old.map(item => item.id === id ? { ...item, ...changes } : item));

  const submit = event => {
    event.preventDefault();

    if (name.trim().length < 2) {
      window.alert('اكتب اسم الموظف بشكل صحيح.');
      return;
    }

    const clean = buildFormItems(items, name.trim());

    if (!clean.length) return;
    if (hasIncompleteSharedItem(clean)) {
      window.alert('الصنف المشترك يحتاج اسم شخص آخر على الأقل غير صاحب الطلب.');
      return;
    }
    if (hasTooManyParticipants(clean)) {
      window.alert('الحد الأقصى للمشاركين في الصنف الواحد هو 20 شخصاً.');
      return;
    }

    onSave({ employee_name: name.trim(), items: clean });
  };

  return <form className="edit-order" onSubmit={submit}>
    <label>اسم الموظف</label>
    <input required minLength="2" maxLength="100" value={name} onChange={e => setName(e.target.value)} />

    {items.map((item, index) => <div className="edit-item" key={item.id || index}>
      <input required maxLength="180" value={item.description} onChange={e => patch(item.id, { description: e.target.value })} placeholder="اسم الصنف" />
      <input type="number" min="1" max="99" value={item.quantity} onChange={e => patch(item.id, { quantity: e.target.value })} />
      <select value={item.kind} onChange={e => patch(item.id, { kind: e.target.value })}>
        <option value="individual">فردي</option>
        <option value="shared">مشترك</option>
      </select>
      {item.kind === 'shared' && <div className="participant-picker" style={{display:"grid",gap:8,padding:10,border:"1px solid var(--line,#e6dfd0)",borderRadius:10}}><b>المشاركون</b>
        {employeeNames.filter(person => person !== name.trim()).map(person => {
          const selected = (item.participantsText || '').split(/[،,]/).map(x => x.trim()).includes(person);
          return <label key={person}><input type="checkbox" checked={selected} onChange={e => {
            const selectedNames = (item.participantsText || '').split(/[،,]/).map(x => x.trim()).filter(Boolean);
            const next = e.target.checked ? [...selectedNames, person] : selectedNames.filter(x => x !== person);
            patch(item.id, { participantsText: next.join('، ') });
          }} /> {person}</label>;
        })}
      </div>}
      <button type="button" className="remove-link" onClick={() => setItems(old => old.filter(x => x !== item))}>حذف الصنف</button>
    </div>)}

    <button type="button" className="add-item" onClick={() => setItems(old => [...old, { id: crypto.randomUUID(), description: '', quantity: 1, kind: 'individual', participantsText: '' }])}>＋ إضافة صنف</button>

    <div className="inline-actions">
      <button type="button" className="secondary" onClick={onCancel}>إلغاء</button>
      <button className="primary" disabled={busy}>حفظ التعديلات</button>
    </div>
  </form>;
}

function RestaurantMenuPanel({ round, restaurants = [], onAssign, busy, onAdd, onImportRoundItems, onApprove, onDismiss }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const run = async action => { try { setError(''); await action(); } catch (err) { setError(err?.message || 'تعذر حفظ التغيير.'); } };
  return <div className="panel card">
    <div className="panel-title"><div><h3>منيو المطعم</h3><p className="muted">الأصناف المعتمدة تظهر للموظفين في نموذج الطلب.</p></div><strong>{round.menuItems?.length || 0} صنف</strong></div>
    {!round.restaurant_id ? <div className="empty-inline" style={{display:'grid',gap:10}}><span>هذه الجولة غير مرتبطة بمطعم. اختر المطعم المناسب لربطها بقائمته.</span><select defaultValue="" onChange={e=>e.target.value && onAssign(e.target.value)}><option value="">اختر مطعماً محفوظاً</option>{restaurants.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></div> : <>
      <form onSubmit={e => { e.preventDefault(); if (name.trim()) run(async () => { await onAdd(name); setName(''); }); }} style={{display:'grid',gap:8,margin:'14px 0'}}>
        <textarea value={name} onChange={e=>setName(e.target.value)} rows="4" placeholder="أضف صنفاً واحداً أو الصق قائمة كاملة — كل صنف في سطر" required />
        <button className="primary" disabled={busy}>إضافة الأصناف إلى المنيو</button>
      </form>
      {error && <div className="inline-error">{error}</div>}
      <button type="button" className="secondary small-btn" disabled={busy || !(round.orders || []).some(order => (order.order_items || []).length)} onClick={() => run(onImportRoundItems)}>استخراج أصناف طلبات هذه الجولة وإضافتها للمنيو</button>
      <small className="hint">استخدمه إذا كانت هذه الجولة تخص المطعم المحدد؛ سيحوّل الأصناف المطلوبة سابقاً إلى قائمة اختيار موحدة.</small>
      <div className="order-list">{(round.menuItems || []).map(item => <div className="order-card" key={item.id}><b>{item.name}</b></div>)}</div>
      <div className="form-divider" />
      <h4>طلبات إضافة أصناف من الموظفين ({round.menuRequests?.length || 0})</h4>
      {!round.menuRequests?.length ? <div className="empty-inline">لا توجد طلبات جديدة.</div> : round.menuRequests.map(request => <div className="order-card" key={request.id} style={{display:'flex',justifyContent:'space-between',gap:10,alignItems:'center',flexWrap:'wrap'}}><div><b>{request.requested_name}</b><small>طلبه: {request.requested_by_name}</small></div><div className="order-actions"><button className="primary small-btn" onClick={()=>run(()=>onApprove(request))}>اعتماد</button><button className="text-btn danger" onClick={()=>run(()=>onDismiss(request))}>رفض</button></div></div>)}
    </>}
  </div>;
}

function RestaurantOrderSummary({ round }) {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const order of round.orders || []) {
      for (const item of order.order_items || order.items || []) {
        const label = cleanItemLabel(item.description || '');
        if (!label) continue;
        const key = normalizeItemName(label);
        const current = map.get(key) || { key, label, quantity: 0, employees: new Map() };
        const quantity = Math.max(1, Number(item.quantity) || 1);
        current.quantity += quantity;
        const employee = String(order.employee_name || '').trim() || 'غير محدد';
        current.employees.set(employee, (current.employees.get(employee) || 0) + quantity);
        map.set(key, current);
      }
    }
    return [...map.values()]
      .map(item => ({ ...item, employees: [...item.employees.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ar')) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ar'));
  }, [round.orders]);

  const totalUnits = grouped.reduce((sum, item) => sum + item.quantity, 0);
  const message = [
    '🍽️ FORKS UP | HALL NO. 213',
    '📋 تجميع طلب المطعم',
    `الجولة: ${round.food_type}`,
    round.title ? `التفاصيل: ${round.title}` : '',
    `عدد الموظفين: ${new Set((round.orders || []).map(order => order.employee_name).filter(Boolean)).size}`,
    `إجمالي الوحدات: ${totalUnits}`,
    '════════════════',
    ...grouped.map((item, index) => [
      `${index + 1}. ${item.label} × ${item.quantity}`,
      `   الطلبات: ${item.employees.map(([name, quantity]) => `${name} (${quantity})`).join('، ')}`
    ].join('\\n')),
    '',
    'Bite Together. Order Smarter.'
  ].filter(Boolean).join('\\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      window.alert('تم نسخ تجميع الطلبات.');
    } catch {
      window.prompt('انسخ تجميع الطلبات:', message);
    }
  };

  return <div className="panel card">
    <div className="panel-title">
      <div>
        <h3>تجميع طلب المطعم</h3>
        <p className="muted">كل الأصناف من جميع الموظفين مجمّعة حسب الاسم، لتعرف الكمية النهائية التي ستطلبها من المطعم.</p>
      </div>
      <strong>{grouped.length} أصناف</strong>
    </div>
    {!grouped.length ? <div className="empty-inline">لا توجد طلبات مسجلة في هذه الجولة حتى الآن.</div> : <>
      <div className="summary-grid" style={{ marginBottom: 16 }}>
        <Stat label="إجمالي الوحدات المطلوبة" value={totalUnits} />
        <Stat label="عدد الموظفين" value={new Set((round.orders || []).map(order => order.employee_name).filter(Boolean)).size} />
        <Stat label="عدد الأصناف المختلفة" value={grouped.length} />
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {grouped.map((item, index) => <div key={item.key} style={{ border: '1px solid var(--line,#e6dfd0)', borderRadius: 12, padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 8, alignItems: 'center' }}>
          <div>
            <b>{index + 1}. {item.label}</b>
            <div className="muted" style={{ fontSize: 13, marginTop: 5 }}>
              {item.employees.map(([name, quantity]) => `${name} (${quantity})`).join(' · ')}
            </div>
          </div>
          <strong style={{ color: 'var(--primary,#174b3b)', fontSize: 22, whiteSpace: 'nowrap' }}>× {item.quantity}</strong>
        </div>)}
      </div>
      <div className="inline-actions" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={copy}>نسخ الملخص</button>
        <button className="whatsapp-btn" onClick={() => openWhatsAppMessage(message)}>إرسال للمطعم عبر WhatsApp ↗</button>
      </div>
    </>}
  </div>;
}

function InvoicePanel({ round, busy, onSave, onPriceSave }) {
  const lines = useMemo(() => aggregateItems(round.orders), [round.orders]);
  const imageRefs = useRef({});
  const [exporting, setExporting] = useState('');
  const [imageTarget, setImageTarget] = useState(null);

  const exportInvoiceImage = (key, fileName, share = false) => {
    if (exporting) return;
    imageRefs.current = {};
    setExporting(key);
    setImageTarget({ key, fileName, share });
  };

  useEffect(() => {
    if (!imageTarget) return;
    let cancelled = false;
    const createImage = async () => {
      try {
        // Mount only the requested invoice image; rendering every employee's
        // hidden image at once can freeze mobile browsers on large rounds.
        await new Promise(resolve => requestAnimationFrame(resolve));
        const node = imageRefs.current[imageTarget.key];
        if (!node) throw new Error('Invoice image is not ready');
        const dataUrl = await toPng(node, { pixelRatio: 2, backgroundColor: '#f7f3e9', cacheBust: true });
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        const file = new File([blob], imageTarget.fileName, { type: 'image/png' });

        if (imageTarget.share && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
          await navigator.share({ files: [file], title: 'Forks Up', text: 'كشف حساب من Forks Up · Hall 213' });
        } else {
          const link = document.createElement('a');
          link.href = dataUrl;
          link.download = imageTarget.fileName;
          document.body.appendChild(link);
          link.click();
          link.remove();
          if (imageTarget.share) openWhatsAppMessage('تم تجهيز صورة كشف الحساب. أرفق الصورة التي تم تنزيلها في هذه المحادثة.');
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) window.alert(err?.name === 'AbortError' ? 'تم إلغاء المشاركة.' : 'تعذر إنشاء صورة الكشف. حاول مرة أخرى أو استخدم إرسال النص.');
      } finally {
        if (!cancelled) {
          setImageTarget(null);
          setExporting('');
        }
      }
    };
    createImage();
    return () => { cancelled = true; };
  }, [imageTarget]);

  const [prices, setPrices] = useState(round.prices || {});
  const [delivery, setDelivery] = useState(round.delivery_fee || 0);

  useEffect(() => {
    setPrices(round.prices || {});
    setDelivery(round.delivery_fee || 0);
  }, [round.id, round.prices, round.delivery_fee]);

  const result = useMemo(() => calculateBills(round.orders, prices, delivery), [round.orders, prices, delivery]);

  const missingPrices = lines.filter(line =>
    prices[line.key] === undefined ||
    prices[line.key] === '' ||
    !Number.isFinite(Number(prices[line.key]))
  );
  return <div className="panel card">
    {!isRoundOpen(round) && <div className="deadline-note" style={{ marginBottom: 14 }}>
      تم إغلاق استقبال الطلبات. يمكنك الآن، بصفتك المسؤول، استكمال إدخال الأسعار وحفظ الفواتير وإرسال الحسابات الفردية والجماعية دون إعادة فتح الجولة.
    </div>}
    <div className="panel-title">
      <div>
        <h3>إدخال الفاتورة</h3>
        <p className="muted">اكتب سعر الوحدة لكل صنف كما ورد في فاتورة المطعم.</p>
      </div>
      <button className="primary small-btn" disabled={busy || missingPrices.length > 0 || false} onClick={() => onSave(prices, delivery)}>حفظ الحسابات</button>
    </div>

    {!lines.length ? <div className="empty-inline">أضف طلبات أولاً حتى تظهر الأصناف هنا.</div> : <>
      <div className="price-table">
        <div className="price-row table-head"><span>الصنف</span><span>الكمية</span><span>سعر الوحدة</span></div>
        {lines.map(line => <div className="price-row" key={line.key}>
          <b>{line.label}</b>
          <span>{line.quantity}</span>
          <input type="number" min="0" step="0.01" value={prices[line.key] ?? ''} placeholder="0.00"
            onChange={e => setPrices(old => ({ ...old, [line.key]: e.target.value }))}
            onBlur={e => {
              const value = e.target.value;
              if (value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) {
                onPriceSave(line, value).catch(() => {});
              }
            }} />
        </div>)}
      </div>

      {missingPrices.length > 0 && <div className="inline-error">أدخل سعر كل الأصناف أولاً حتى لا يظهر حساب غير مكتمل. المتبقي: {missingPrices.map(item => item.label).join('، ')}</div>}

      <div className="delivery-row">
        <label>إجمالي التوصيل والمصاريف الإضافية (ج.م)
          <input type="number" min="0" step="0.01" value={delivery}  onChange={e => setDelivery(e.target.value)} />
        </label>
        <small>يُقسم بالتساوي على جميع المشاركين، بمن فيهم من شارك في صنف مشترك.</small>
      </div>

      {missingPrices.length === 0 && <div className="bill-list">
        <div className="bill-title"><h3>كشوف الحسابات</h3><b>إجمالي الفاتورة: {money(result.grandTotal)}</b></div>
        <div className="bill-sharing-options">
          <p className="muted">اختر طريقة إرسال الكشف عبر WhatsApp:</p>
          <div className="invoice-action-row">
            <button className="whatsapp-btn" disabled={!!exporting} onClick={() => exportInvoiceImage('group', 'Forks-Up-Group-Bill.png', true)}>{exporting === 'group' ? 'جارٍ تجهيز الصورة...' : 'مشاركة صورة الكشف الجماعي'}</button>
            <button className="secondary small-btn" disabled={!!exporting} onClick={() => exportInvoiceImage('group', 'Forks-Up-Group-Bill.png')}>تنزيل صورة الكشف</button>
            <button className="whatsapp-btn" onClick={() => shareGroupBill(round, result)}>إرسال النص الجماعي عبر WhatsApp ↗</button>
          </div>
        </div>

        {result.people.map(person => {
          return <div className="bill-person" key={person}>
            <div className="bill-person-head">
              <b>{person}</b>
              <strong>{money(result.bills[person].total)}</strong>
            </div>
            <div className="bill-details">
              {result.bills[person].items.map((item, index) => <div key={`${item.description}-${index}`}>
                <span>{item.description} × {item.quantity}{item.shared ? ' (مشترك)' : ' (فردي)'}</span>
                <span>{money(item.amount)}</span>
              </div>)}
              <div><span>نصيب التوصيل والمصاريف</span><span>{money(result.bills[person].delivery)}</span></div>
            </div>
            <div className="invoice-action-row">
              <button className="whatsapp-btn" disabled={!!exporting} onClick={() => exportInvoiceImage(person, `Forks-Up-${safeFileName(person)}.png`, true)}>{exporting === person ? 'جارٍ تجهيز الصورة...' : 'مشاركة صورة الكشف'}</button>
              <button className="secondary small-btn" disabled={!!exporting} onClick={() => exportInvoiceImage(person, `Forks-Up-${safeFileName(person)}.png`)}>تنزيل الصورة</button>
              <button className="whatsapp-btn" onClick={() => shareBill(round, person, result.bills[person])}>إرسال النص عبر WhatsApp ↗</button>
            </div>
          </div>;
        })}
      </div>}

    </>}

    {imageTarget && missingPrices.length === 0 && <div style={{ position: 'fixed', left: '-10000px', top: 0, width: '820px', pointerEvents: 'none' }} aria-hidden="true">
      {imageTarget.key === 'group' ? (
        <InvoiceImageCard refCallback={node => { imageRefs.current.group = node; }} round={round} title="كشف الحساب الجماعي" people={result.people.map(person => ({ name: person, bill: result.bills[person] }))} grandTotal={result.grandTotal} />
      ) : (
        <InvoiceImageCard refCallback={node => { imageRefs.current[imageTarget.key] = node; }} round={round} title={`كشف حساب: ${imageTarget.key}`} people={[{ name: imageTarget.key, bill: result.bills[imageTarget.key] }]} grandTotal={result.bills[imageTarget.key]?.total || 0} />
      )}
    </div>}
  </div>;
}

function safeFileName(value) {
  return String(value || 'Employee').replace(/[^\w\u0600-\u06FF-]+/g, '-').slice(0, 50);
}

function InvoiceImageCard({ refCallback, round, title, people, grandTotal }) {
  return <div ref={refCallback} dir="rtl" style={{ width: '820px', boxSizing: 'border-box', padding: '42px', background: '#f7f3e9', color: '#252b28', fontFamily: 'Arial, sans-serif' }}>
    <div style={{ background: '#174b3b', color: '#fffaf0', borderRadius: '22px', padding: '26px 34px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '22px' }}>
      <img src="/forks-up-192.png" alt="Forks Up" crossOrigin="anonymous" style={{ width: '116px', height: '116px', objectFit: 'contain', borderRadius: '16px', background: '#f7f3e9', flexShrink: 0 }} />
      <div>
      <div style={{ fontSize: '15px', letterSpacing: '2px', color: '#f5b66b', fontWeight: 700 }}>FORKS UP · HALL NO. 213</div>
      <div style={{ fontSize: '34px', fontWeight: 800, marginTop: '12px' }}>{title}</div>
      <div style={{ fontSize: '18px', marginTop: '10px', opacity: .9 }}>{round.food_type}{round.title ? ` · ${round.title}` : ''}</div>
      </div>
    </div>
    {people.map(person => <div key={person.name} style={{ background: '#fffdf7', border: '1px solid #e6dfd0', borderRadius: '18px', padding: '24px', marginBottom: '18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #e9e1d2', paddingBottom: '14px', marginBottom: '14px' }}>
        <strong style={{ fontSize: '24px' }}>{person.name}</strong><strong style={{ fontSize: '24px', color: '#174b3b' }}>{money(person.bill.total)}</strong>
      </div>
      {person.bill.items.map((item, index) => <div key={index} style={{ display: 'flex', justifyContent: 'space-between', gap: '18px', padding: '10px 0', borderBottom: '1px solid #eee8dc', fontSize: '17px' }}>
        <span>{item.description} × {item.quantity} <small style={{ color: '#777' }}>({item.shared ? 'مشترك' : 'فردي'})</small></span><strong style={{ whiteSpace: 'nowrap' }}>{money(item.amount)}</strong>
      </div>)}
      <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '14px', fontSize: '16px' }}><span>نصيب التوصيل والمصاريف</span><strong>{money(person.bill.delivery)}</strong></div>
    </div>)}
    <div style={{ background: '#f5b66b', borderRadius: '18px', padding: '22px 26px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#26312b' }}>
      <strong style={{ fontSize: '22px' }}>الإجمالي المطلوب</strong><strong style={{ fontSize: '30px' }}>{money(grandTotal)}</strong>
    </div>
    <div style={{ textAlign: 'center', color: '#647068', fontSize: '14px', marginTop: '22px' }}>Bite Together. Order Smarter.</div>
  </div>;
}

function openWhatsAppMessage(message) {
  window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
}

function formatBillDetails(bill) {
  const details = bill.items.map(item =>
    `• ${item.description} × ${item.quantity} — ${item.shared ? 'نصيبي من الصنف المشترك' : 'صنف فردي'}: ${money(item.amount)}`
  );
  if (!details.length) details.push('• لا توجد أصناف مسجلة');
  details.push(`• نصيب التوصيل والمصاريف: ${money(bill.delivery)}`);
  return details.join('\n');
}

function shareBill(round, person, bill) {
  const message = [
    '🍽️ FORKS UP | HALL NO. 213',
    `كشف حساب: ${person}`,
    `الجولة: ${round.food_type}`,
    round.title ? `تفاصيل الجولة: ${round.title}` : '',
    '────────────────',
    'تفاصيل الطلب:',
    formatBillDetails(bill),
    '────────────────',
    `💰 الإجمالي المطلوب: ${money(bill.total)}`,
    '',
    'Bite Together. Order Smarter.'
  ].filter(Boolean).join('\n');
  openWhatsAppMessage(message);
}

function shareGroupBill(round, result) {
  const sections = result.people.map((person, index) => {
    const bill = result.bills[person];
    return [
      `👤 ${index + 1}) ${person}`,
      formatBillDetails(bill),
      `الإجمالي: ${money(bill.total)}`,
    ].join('\n');
  });
  const message = [
    '🍽️ FORKS UP | HALL NO. 213',
    'كشف الحساب الجماعي',
    `الجولة: ${round.food_type}`,
    round.title ? `تفاصيل الجولة: ${round.title}` : '',
    `عدد الموظفين: ${result.people.length}`,
    '════════════════',
    ...sections.flatMap(section => [section, '────────────────']),
    `🧾 إجمالي فاتورة الجولة: ${money(result.grandTotal)}`,
    '',
    'Bite Together. Order Smarter.'
  ].filter(Boolean).join('\n');
  openWhatsAppMessage(message);
}

function SharePanel({ round }) {
  const link = publicUrl(round.public_token);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('انسخ الرابط:', link);
    }
  };

  const message = `جولة طلب الطعام: ${round.food_type}${round.title ? ` — ${round.title}` : ''}\nسجل طلبك من هنا: ${link}`;
  const reminderMessage = `⏰ تذكير من Forks Up: استقبال الطلبات لجولة ${round.food_type}${round.title ? ` — ${round.title}` : ''} ${round.deadline ? `سينتهي في ${dateLabel(round.deadline)}` : 'سيغلق قريبًا'}. إذا لم تسجل طلبك بعد، استخدم الرابط: ${link}`;

  return <div className="share-layout">
    <div className="panel card share-copy">
      <p className="eyebrow">رابط الموظفين</p>
      <h3>خلي الطلب يوصل لكل الناس.</h3>
      <p className="muted">أي موظف يمسح الكود أو يفتح الرابط يقدر يسجل طلبه من المتصفح، بدون تنزيل التطبيق أو إنشاء حساب.</p>
      <div className="url-box" dir="ltr">{link}</div>
      <button className="primary" onClick={copy}>{copied ? '✓ تم النسخ' : 'نسخ الرابط'}</button>
      <a className="secondary link-button" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">إرسال الرابط عبر WhatsApp</a>
      <a className="secondary link-button" href={`https://wa.me/?text=${encodeURIComponent(reminderMessage)}`} target="_blank" rel="noreferrer">إرسال تذكير للموظفين عبر WhatsApp</a>
      <p className="muted">حالة الجولة: {isRoundOpen(round) ? 'تستقبل الطلبات' : 'مغلقة حالياً'}</p>
    </div>

    <div className="panel card qr-panel">
      <QRCodeSVG value={link} size={210} level="H" includeMargin />
      <b>Forks Up · HALL 213</b>
      <small>امسح الكود لتسجيل طلبك</small>
    </div>
  </div>;
}

function BackupPanel({ busy, onExport, onImport }) {
  const inputRef = useRef(null);
  return <div className="sub-panel" style={{ border: '1px solid var(--line,#e6dfd0)', borderRadius: 14, padding: 14 }}>
    <h4>النسخ الاحتياطي</h4>
    <p className="muted">تصدير جولاتك وطلباتها وأسعارها وسجلها، أو دمج نسخة محفوظة سابقًا.</p>
    <div style={{ display: 'grid', gap: 8 }}>
      <button className="primary small-btn" disabled={busy} onClick={onExport}>تنزيل نسخة احتياطية JSON</button>
      <button className="secondary small-btn" disabled={busy} onClick={()=>inputRef.current?.click()}>استعادة / دمج نسخة احتياطية</button>
      <input ref={inputRef} type="file" accept="application/json,.json" hidden onChange={e=>{onImport(e.target.files?.[0]);e.target.value='';}} />
    </div>
    <small className="hint">الاستعادة تدمج البيانات ولا تحذف بياناتك الحالية. احتفظ بالملف في مكان آمن.</small>
  </div>;
}

function HistoryPanel({ logs }) {
  const actionLabel = action =>
    action === 'order_deleted' ? 'حذف طلب' :
    action === 'order_created' ? 'إضافة طلب بواسطة المسؤول' :
    'تعديل طلب';

  return <div className="panel card">
    <div className="panel-title">
      <div>
        <h3>سجل التعديلات</h3>
        <p className="muted">يسجل النظام عمليات إضافة الطلبات وتعديلها وحذفها ووقت تنفيذها.</p>
      </div>
    </div>

    {!logs.length
      ? <div className="empty-inline">لا توجد تعديلات مسجلة لهذه الجولة حتى الآن.</div>
      : <div className="history-list">
          {logs.map(log => <div className="history-row" key={log.id}>
            <b>{actionLabel(log.action)}</b>
            <span>{log.after_data?.employee_name || log.before_data?.employee_name || 'موظف'}</span>
            <time>{dateLabel(log.created_at)}</time>
          </div>)}
        </div>}
  </div>;
}

export default App;