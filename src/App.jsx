
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toPng } from 'html-to-image';
import { QRCodeSVG } from 'qrcode.react';
import { isConfigured, supabase } from './lib/supabase.js';
import { aggregateItems, calculateBills, cleanItemLabel, getParticipants, money, normalizeItemName } from './lib/billing.js';

const dateLabel = value => value ? new Date(value).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : 'بدون موعد إغلاق';
const shortTime = value => value ? new Date(value).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
const isRoundOpen = round => round?.status === 'open' && (!round.deadline || new Date(round.deadline).getTime() > Date.now());
const publicUrl = token => `${window.location.origin}${window.location.pathname}?token=${encodeURIComponent(token)}`;

const THEME_OPTIONS = [
  { value: 'auto', label: 'تلقائي حسب المطعم ونوع الطعام' },
  { value: 'seafood', label: 'بحري — أسماك ومأكولات بحرية' },
  { value: 'bistro', label: 'Bistro — برجر وسندوتشات' },
  { value: 'pizza', label: 'بيتزا' },
  { value: 'grill', label: 'مشويات' },
  { value: 'general', label: 'Forks Up — الكلاسيكي' }
];

const resolveTheme = round => {
  const selected = round?.theme_key || 'auto';
  if (selected !== 'auto') return selected;
  const restaurant = String(round?.restaurant_name || '').toLocaleLowerCase('ar');
  const food = String(round?.food_type || '').toLocaleLowerCase('ar');
  if (restaurant.includes('أسماك') || restaurant.includes('الحوت') || /سمك|جمبري|بحر|مأكولات بحرية/.test(food)) return 'seafood';
  if (restaurant.includes('bistro') || /برجر|سندوتش|ساندوتش|هوت دوج/.test(food)) return 'bistro';
  if (/بيتزا|pizza/.test(food)) return 'pizza';
  if (/مشوي|كباب|كفتة|فراخ مشوية|شواية/.test(food)) return 'grill';
  return 'general';
};

const THEME_PRESENTATION = {
  seafood: { label: 'Straight from the sea, with a little wow! 🌊', icon: '🦐', note: "Fun fact: A shrimp's heart is actually located in its head." },
  bistro: { label: 'Stacked with Flavor. Loaded with Happiness. 🍔', icon: '🍔', note: 'Fun fact: The modern hamburger became popular in the United States in the late 1800s — but its exact inventor is still debated!' },
  pizza: { label: 'A Little Slice of Food Science. 🍕', icon: '🍕', note: 'Mozzarella’s famous cheese pull comes from its stretchy protein network.' },
  grill: { label: 'Where Fire Turns Into Flavor. 🔥', icon: '🥩', note: 'High-heat browning creates hundreds of delicious new flavor compounds.' },
  general: { label: 'Good Food. Great Company. 🍽️', icon: '🍽️', note: 'Your sense of smell does a huge part of the work behind every flavor.' }
};

const toItemsPayload = items => items.filter(item => item.description?.trim()).map(item => ({
  description: [item.description.trim(), item.variant].filter(Boolean).join(' — '),
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
  const [employees, setEmployees] = useState([]);
  const [showEmployeeManager, setShowEmployeeManager] = useState(false);



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

  const loadEmployees = useCallback(async () => {
    if (!session?.user?.id) return [];
    const { data, error: queryError } = await supabase.from('employee_directory').select('id,employee_name,category,sort_order,normalized_name').order('sort_order').order('category').order('employee_name');
    if (queryError) throw queryError;
    setEmployees(data || []);
    return data || [];
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
    const menusResult = restaurantId
      ? await supabase.from('restaurant_menus').select('*').eq('restaurant_id', restaurantId).order('created_at')
      : { data: [], error: null };
    if (menusResult.error) throw menusResult.error;
    const availableMenus = menusResult.data || [];
    const currentMenu = availableMenus.find(menu => menu.id === roundResult.data.menu_id);
    const bistroMenu = availableMenus.find(menu => menu.name?.trim().toLowerCase() === 'bistro');
    const preferredMenu = bistroMenu || availableMenus[0] || null;
    const effectiveMenuId = bistroMenu
      ? bistroMenu.id
      : (currentMenu?.id || preferredMenu?.id || null);
    if (effectiveMenuId && effectiveMenuId !== roundResult.data.menu_id) {
      const { error: linkError } = await supabase.from('rounds').update({ menu_id: effectiveMenuId }).eq('id', id);
      if (linkError) throw linkError;
    }
    const [menuResult, requestResult, employeeResult, categoriesResult] = await Promise.all([
      effectiveMenuId ? supabase.from('restaurant_menu_items').select('*').eq('menu_id', effectiveMenuId).eq('active', true).order('sort_order').order('name') : Promise.resolve({ data: [], error: null }),
      restaurantId ? supabase.from('menu_item_requests').select('*').eq('round_id', id).order('created_at', { ascending: true }) : Promise.resolve({ data: [], error: null }),
      supabase.from('employee_directory').select('id,employee_name,category,sort_order,normalized_name').order('sort_order').order('category').order('employee_name'),
      effectiveMenuId ? supabase.from('restaurant_menu_categories').select('*').eq('menu_id', effectiveMenuId).order('sort_order').order('name') : Promise.resolve({ data: [], error: null })
    ]);
    for (const result of [menuResult, requestResult, employeeResult, categoriesResult]) if (result.error) throw result.error;

    setEmployees(employeeResult.data || []);

    const priceMap = Object.fromEntries(
      (priceResult.data || []).map(row => [row.normalized_name, Number(row.unit_price)])
    );

    setRoundData({
      ...roundResult.data,
      menu_id: effectiveMenuId,
      orders: orderResult.data || [],
      prices: priceMap,
      priceRows: priceResult.data || [],
      logs: logResult.data || [],
      menuItems: menuResult.data || [],
      menus: menusResult.data || [],
      menuCategories: categoriesResult.data || [],
      menuRequests: requestResult.data || [],
      employeeDirectory: employeeResult.data || [],
      employeeNames: [...new Set([...(employeeResult.data || []).map(row => row.employee_name), ...getParticipants(orderResult.data || [])])].sort((a,b) => a.localeCompare(b,'ar'))
    });
  }, []);

  useEffect(() => {
    if (session) {
      loadRounds().catch(report);
      loadRestaurants().catch(report);
      loadEmployees().catch(report);
    } else {
      setRounds([]);
      setRoundData(null);
    }
  }, [session, loadRounds, loadRestaurants, loadEmployees, report]);

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
      let selectedMenuId = form.menuId || null;
      if (!selectedMenuId && form.restaurantId) {
        const restaurant = restaurants.find(row => row.id === form.restaurantId);
        let menuQuery = supabase.from('restaurant_menus').select('id,name').eq('restaurant_id', form.restaurantId);
        if (restaurant?.name?.trim().toLowerCase() === 'bistro') {
          const { data: bistroMenu, error: bistroMenuError } = await menuQuery.eq('name', 'Bistro').maybeSingle();
          if (bistroMenuError) throw bistroMenuError;
          selectedMenuId = bistroMenu?.id || null;
        }
        if (!selectedMenuId) {
          const { data: defaultMenu, error: menuLookupError } = await supabase.from('restaurant_menus').select('id').eq('restaurant_id', form.restaurantId).order('created_at').limit(1).maybeSingle();
          if (menuLookupError) throw menuLookupError;
          selectedMenuId = defaultMenu?.id || null;
        }
      }
      const menuFiles = Array.isArray(form.files) ? form.files : (form.file ? [form.file] : []);
      if (menuFiles.length > 12) throw new Error('يمكنك إضافة 12 ملفًا كحد أقصى.');
      for (const file of menuFiles) {
        if (file.size > 10 * 1024 * 1024) throw new Error(`حجم الملف "${file.name}" يجب ألا يتجاوز 10 ميجابايت.`);
        if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) {
          throw new Error(`صيغة الملف "${file.name}" غير مدعومة. استخدم JPG أو PNG أو WEBP أو PDF.`);
        }
      }

      const { data, error: insertError } = await supabase.from('rounds').insert({
        created_by: session.user.id,
        title: form.title.trim(),
        food_type: form.foodType.trim(),
        restaurant_id: form.restaurantId || null,
        menu_id: selectedMenuId,
        deadline: form.deadline || null,
        status: 'open',
        theme_key: form.themeKey || 'auto'
      }).select().single();

      if (insertError) throw insertError;

      createdRoundId = data.id;

      const uploadedMenuPaths = [];
      for (const file of menuFiles) {
        const safeName = file.name.replace(/[^\w.\-\u0600-\u06FF]/g, '_');
        const path = `${session.user.id}/${data.id}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
        const { error: uploadError } = await supabase.storage
          .from('round-menus')
          .upload(path, file, { upsert: false, contentType: file.type });
        if (uploadError) throw uploadError;
        uploadedMenuPaths.push(path);
      }
      if (uploadedMenuPaths.length) {
        const { error: updateError } = await supabase.from('rounds')
          .update({ menu_path: uploadedMenuPaths[0], menu_paths: uploadedMenuPaths })
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
        const { data: existingRound } = await supabase.from('rounds').select('menu_paths,menu_path').eq('id', createdRoundId).maybeSingle();
        const cleanupPaths = [...new Set([...(existingRound?.menu_paths || []), existingRound?.menu_path].filter(Boolean))];
        if (cleanupPaths.length) await supabase.storage.from('round-menus').remove(cleanupPaths);
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
      themeKey: roundData.theme_key || 'auto',
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

  const saveEmployee = async employee => {
    setBusy(true);
    setError('');
    try {
      const original = employees.find(row => row.id === employee.id);
      const nextOrder = Math.max(0, Math.min(9999, Math.trunc(Number(employee.sort_order) || 0)));
      // Save order directly so order-only edits do not depend on the rename RPC.
      const { data: orderRow, error: orderError } = await supabase
        .from('employee_directory')
        .update({ sort_order: nextOrder })
        .eq('id', employee.id)
        .select('id')
        .maybeSingle();
      if (orderError) throw orderError;
      if (!orderRow) throw new Error('لم يتم حفظ الترتيب. تحقق من صلاحيات المسؤول أو نفّذ تحديث قاعدة البيانات الخاص بإدارة الموظفين.');

      const nameChanged = employee.employee_name.trim() !== (original?.employee_name || '').trim();
      const categoryChanged = (employee.category || '').trim() !== (original?.category || '').trim();
      if (nameChanged || categoryChanged) {
        const { error: saveError } = await supabase.rpc('admin_update_employee', {
          p_employee_id: employee.id,
          p_employee_name: employee.employee_name.trim(),
          p_category: (employee.category || '').trim(),
          p_sort_order: nextOrder
        });
        if (saveError) throw saveError;
      }
      await loadEmployees();
      if (activeId && (nameChanged || categoryChanged)) await loadRound(activeId);
      flash(nameChanged || categoryChanged ? 'تم حفظ بيانات الموظف وتحديث الاسم في السجلات السابقة' : 'تم حفظ ترتيب الموظف');
    } catch (err) {
      await loadEmployees().catch(() => {});
      report(err);
    } finally { setBusy(false); }
  };

  const moveEmployee = async (employee, direction) => {
    const group = employees.filter(row => (row.category || '') === (employee.category || '')).sort((a,b) => (a.sort_order || 0)-(b.sort_order || 0));
    const index = group.findIndex(row => row.id === employee.id);
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= group.length) return;
    const reordered = [...group];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    setBusy(true);
    try {
      const results = await Promise.all(reordered.map((row, position) =>
        supabase.from('employee_directory').update({sort_order: position}).eq('id', row.id)
      ));
      const failed = results.find(result => result.error);
      if (failed) throw failed.error;
      await loadEmployees();
    } catch (err) { report(err); }
    finally { setBusy(false); }
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

      {rounds.length > 0 && <div className="round-switch" style={{ marginBottom: 18 }}>
        <span>التنقل بين الجولات ({rounds.length})</span>
        <input value={roundSearch} onChange={event => setRoundSearch(event.target.value)} placeholder="ابحث بنوع الطعام أو اسم الجولة" aria-label="البحث في الجولات" />
        <select value={activeId || ''} onChange={event => setActiveId(event.target.value)}>
          {rounds.filter(round => `${round.food_type} ${round.title || ''} ${new Date(round.created_at).toLocaleDateString('ar-EG')}`.toLocaleLowerCase('ar').includes(roundSearch.trim().toLocaleLowerCase('ar'))).map(round => <option key={round.id} value={round.id}>
            {round.food_type} — {round.title || 'جولة'} — {new Date(round.created_at).toLocaleDateString('ar-EG')}
          </option>)}
        </select>
      </div>}

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

        <div className="theme-admin-control card" style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,padding:'12px 16px',marginBottom:16,flexWrap:'wrap'}}>
          <div><b>هوية الجولة للموظفين</b><small className="muted" style={{display:'block'}}>التلقائي يختار التصميم حسب المطعم ونوع الطعام، ويمكنك تثبيت تصميم محدد.</small></div>
          <select aria-label="ثيم الجولة" value={roundData.theme_key || 'auto'} disabled={busy} onChange={e=>updateRound({theme_key:e.target.value})} style={{minWidth:220,border:'1px solid #dedacf',borderRadius:8,padding:'9px 12px',background:'#fffefa'}}>
            {THEME_OPTIONS.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="card" style={{padding:'14px 16px',marginBottom:16}}>
          <div style={{marginBottom:10}}><b>الأصناف التي تظهر للموظفين</b><small className="muted" style={{display:'block'}}>اختر الأقسام المسموح بطلبها في هذه الجولة فقط. إلغاء جميع الاختيارات يعيد إظهار كل الأقسام.</small></div>
          {(roundData.menuCategories||[]).length ? <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
            {(roundData.menuCategories||[]).map(category=>{
              const allNames=(roundData.menuCategories||[]).map(row=>row.name);
              const visible=roundData.visible_menu_categories==null || roundData.visible_menu_categories.includes(category.name);
              return <label key={category.id||category.name} style={{display:'inline-flex',alignItems:'center',gap:6,margin:0,padding:'7px 10px',border:'1px solid #e5dfd3',borderRadius:9,background:visible?'#edf4ef':'#fffefa',fontSize:12}}>
                <input type="checkbox" checked={visible} disabled={busy} onChange={e=>{
                  const current=roundData.visible_menu_categories==null?allNames:roundData.visible_menu_categories;
                  const next=e.target.checked?[...new Set([...current,category.name])]:current.filter(name=>name!==category.name);
                  updateRound({visible_menu_categories:next.length===0||next.length===allNames.length?null:next});
                }}/>
                {category.name}
              </label>;
            })}
          </div> : <small className="muted">أضف أقسامًا إلى منيو المطعم أولًا حتى تتمكن من تحديد ما يظهر للموظفين.</small>}
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

        {tab === 'menu' && <RestaurantMenuPanel round={roundData} restaurants={restaurants} onAssign={async (restaurantId,menuId) => {
            let targetMenu=menuId||null;
            if(restaurantId&&!targetMenu){
              const restaurant=restaurants.find(r=>r.id===restaurantId);
              if(restaurant?.name?.trim().toLowerCase()==='bistro'){
                const {data,error:e}=await supabase.from('restaurant_menus').select('id').eq('restaurant_id',restaurantId).eq('name','Bistro').maybeSingle();
                if(e)throw e;targetMenu=data?.id||null;
              }
              if(!targetMenu){const {data,error:e}=await supabase.from('restaurant_menus').select('id').eq('restaurant_id',restaurantId).order('created_at').limit(1).maybeSingle();if(e)throw e;targetMenu=data?.id||null;}
            }
            const {data,error:e}=await supabase.from('rounds').update({restaurant_id:restaurantId,menu_id:targetMenu}).eq('id',roundData.id).select('id').maybeSingle();
            if(e)throw e;if(!data)throw new Error('لم يتم ربط المطعم بالجولة. تحقق من صلاحيات المسؤول.');
            await loadRound(roundData.id);await loadRestaurants();flash('تم ربط المطعم والمنيو بالجولة');
          }} busy={busy}
          onCreateMenu={async name => {
            const {data,error:e}=await supabase.from('restaurant_menus').insert({restaurant_id:roundData.restaurant_id,name}).select().single();if(e)throw e;
            const isBistro=restaurants.find(r=>r.id===roundData.restaurant_id)?.name?.trim().toLowerCase()==='bistro';
            const defaults=(isBistro?BISTRO_MENU_CATEGORIES:MENU_CATEGORIES).map((n,i)=>({menu_id:data.id,name:n,sort_order:i}));
            const {error:ce}=await supabase.from('restaurant_menu_categories').insert(defaults);if(ce)throw ce;
            await updateRound({menu_id:data.id});await loadRound(roundData.id);flash('تم إنشاء المنيو وربطه بالجولة');
          }}
          onRenameMenu={async (id,name)=>{const {error:e}=await supabase.from('restaurant_menus').update({name}).eq('id',id);if(e)throw e;await loadRound(roundData.id);flash('تم تعديل اسم المنيو');}}
          onDeleteMenu={async id=>{const other=(roundData.menus||[]).find(m=>m.id!==id);if(!other)throw new Error('يجب الاحتفاظ بمنيو واحد على الأقل.');const {error:e}=await supabase.from('restaurant_menus').delete().eq('id',id);if(e)throw e;await updateRound({menu_id:other.id});await loadRound(roundData.id);flash('تم حذف المنيو');}}
          onAddCategory={async name=>{const {error:e}=await supabase.from('restaurant_menu_categories').insert({menu_id:roundData.menu_id,name,sort_order:(roundData.menuCategories||[]).length});if(e)throw e;await loadRound(roundData.id);}}
          onRenameCategory={async (id,oldName,name)=>{const {error:e}=await supabase.from('restaurant_menu_categories').update({name}).eq('id',id);if(e)throw e;await supabase.from('restaurant_menu_items').update({category:name}).eq('menu_id',roundData.menu_id).eq('category',oldName);await loadRound(roundData.id);}}
          onDeleteCategory={async (id,oldName)=>{await supabase.from('restaurant_menu_items').update({category:'أصناف أخرى'}).eq('menu_id',roundData.menu_id).eq('category',oldName);if(id){const {error:e}=await supabase.from('restaurant_menu_categories').delete().eq('id',id);if(e)throw e;}await loadRound(roundData.id);}}
          onAdd={async item=>{const name=item.name.trim();if(!name)throw new Error('اكتب اسم الصنف.');const row={restaurant_id:roundData.restaurant_id,menu_id:roundData.menu_id,name,normalized_name:normalizeItemName(name),category:item.category,subcategory:item.subcategory||'',preparation:item.preparation||'',weight_options:item.weight_options||[],active:true,sort_order:0};const {error:e}=await supabase.from('restaurant_menu_items').upsert(row,{onConflict:'menu_id,normalized_name'});if(e)throw e;await loadRound(roundData.id);flash('تمت إضافة الصنف');}}
          onSaveItem={async item=>{
            const payload={name:item.name,normalized_name:normalizeItemName(item.name),category:item.category,weight_options:item.weight_options||[],default_price:item.default_price??null,single_price:item.single_price??null,double_price:item.double_price??null,updated_at:new Date().toISOString()};
            const {data,error:e}=await supabase.from('restaurant_menu_items').update(payload).eq('id',item.id).select('id').maybeSingle();
            if(e)throw e;if(!data)throw new Error('لم يتم حفظ التعديل. قد تكون صلاحيات تعديل المنيو غير متاحة لهذا الحساب.');
            await loadRound(roundData.id);flash('تم حفظ تعديل الصنف');
          }}
          onDeleteItem={async item=>{
            const {data,error:e}=await supabase.from('restaurant_menu_items').update({active:false,updated_at:new Date().toISOString()}).eq('id',item.id).select('id').maybeSingle();
            if(e)throw e;if(!data)throw new Error('لم تتم إزالة الصنف. تحقق من صلاحيات المسؤول.');
            await loadRound(roundData.id);flash('تمت إزالة الصنف من المنيو');
          }}
          onImportRoundItems={async()=>{const names=[...new Set((roundData.orders||[]).flatMap(o=>o.order_items||[]).map(i=>i.description?.trim()).filter(Boolean))];if(!names.length)throw new Error('لا توجد أصناف لاستخراجها.');const rows=names.map(name=>({restaurant_id:roundData.restaurant_id,menu_id:roundData.menu_id,name,normalized_name:normalizeItemName(name),category:'أصناف أخرى',active:true}));const {error:e}=await supabase.from('restaurant_menu_items').upsert(rows,{onConflict:'menu_id,normalized_name',ignoreDuplicates:true});if(e)throw e;await loadRound(roundData.id);}}
          onApprove={async request=>{const {error:e}=await supabase.from('restaurant_menu_items').upsert({restaurant_id:roundData.restaurant_id,menu_id:roundData.menu_id,name:request.requested_name,normalized_name:request.normalized_name,category:'أصناف أخرى',active:true},{onConflict:'menu_id,normalized_name'});if(e)throw e;const {error:de}=await supabase.from('menu_item_requests').delete().eq('id',request.id);if(de)throw de;await loadRound(roundData.id);}}
          onDismiss={async request=>{const {error:e}=await supabase.from('menu_item_requests').delete().eq('id',request.id);if(e)throw e;await loadRound(roundData.id);}}
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

      </>}

      <section className="panel card" style={{ marginTop: 24 }}>
        <div className="panel-title" style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
          <div><h3>إدارة الموظفين</h3><p className="muted">تعديل الأسماء المسجلة، تقسيم الموظفين إلى مجموعات، والتحكم في ترتيب ظهورهم.</p></div>
          <button type="button" className="secondary" onClick={()=>setShowEmployeeManager(value=>!value)}>{showEmployeeManager ? 'إخفاء القائمة' : `إدارة ${employees.length} موظف`}</button>
        </div>
        {showEmployeeManager && <EmployeeDirectoryPanel employees={employees} busy={busy} onSave={saveEmployee} onMove={moveEmployee} />}
      </section>

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

function EmployeeDirectoryPanel({ employees = [], busy, onSave, onMove }) {
  const [drafts, setDrafts] = useState({});
  const categories = [...new Set(employees.map(person => (person.category || '').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  const getDraft = person => drafts[person.id] || { employee_name: person.employee_name, category: person.category || '', sort_order: person.sort_order ?? 0 };
  const groups = [...new Set(employees.map(person => (person.category || '').trim() || 'بدون تصنيف'))];
  return <div style={{display:'grid',gap:18,marginTop:16}}>
    <div className="muted" style={{fontSize:13}}>تغيير الاسم ينعكس على الطلبات القديمة والمشاركين في الأصناف المشتركة، دون حذف أي طلب أو فاتورة. استخدم التصنيف مثل: الإدارة، الهندسة، التشغيل.</div>
    {!employees.length ? <div className="empty-inline">لا توجد أسماء مسجلة بعد.</div> : groups.map(group => {
      const rows = employees.filter(person => ((person.category || '').trim() || 'بدون تصنيف') === group).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)||a.employee_name.localeCompare(b.employee_name,'ar'));
      return <div key={group} style={{display:'grid',gap:10}}>
        <h4 style={{margin:'0 0 2px',color:'var(--primary,#174b3b)'}}>{group} <small className="muted">({rows.length})</small></h4>
        {rows.map((person,index)=>{
          const draft=getDraft(person);
          return <div key={person.id} style={{display:'grid',gridTemplateColumns:'minmax(130px,1.3fr) minmax(110px,1fr) 82px auto',gap:8,alignItems:'end',padding:12,border:'1px solid var(--line,#e6dfd0)',borderRadius:12}}>
            <label>اسم الموظف<input value={draft.employee_name} maxLength="100" onChange={e=>setDrafts(old=>({...old,[person.id]:{...getDraft(person),employee_name:e.target.value}}))}/></label>
            <label>التصنيف<input list="employee-category-options" value={draft.category} maxLength="60" placeholder="مثلاً: الهندسة" onChange={e=>setDrafts(old=>({...old,[person.id]:{...getDraft(person),category:e.target.value}}))}/></label>
            <label>الترتيب<input type="number" min="0" max="9999" value={draft.sort_order} onChange={e=>setDrafts(old=>({...old,[person.id]:{...getDraft(person),sort_order:e.target.value}}))}/></label>
            <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
              <button type="button" className="secondary small-btn" title="لأعلى" disabled={busy||index===0} onClick={()=>onMove(person,-1)}>↑</button>
              <button type="button" className="secondary small-btn" title="لأسفل" disabled={busy||index===rows.length-1} onClick={()=>onMove(person,1)}>↓</button>
              <button type="button" className="primary small-btn" disabled={busy||draft.employee_name.trim().length<2} onClick={()=>onSave({...person,...draft})}>حفظ</button>
            </div>
          </div>;
        })}
      </div>;
    })}
    <datalist id="employee-category-options">{categories.map(category=><option key={category} value={category}/>)}</datalist>
  </div>;
}

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
  const [themeKey, setThemeKey] = useState('auto');
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
  const [files, setFiles] = useState([]);
  const [fileInputKey, setFileInputKey] = useState(0);

  const submit = async event => {
    event.preventDefault();

    const created = await onCreate({
      foodType,
      restaurantId,
      themeKey,
      title,
      deadline: deadline ? new Date(deadline).toISOString() : null,
      files
    });

    if (created) {
      setFoodType('');
      setThemeKey('auto');
      setTitle('');
      setDeadline('');
      setFiles([]);
      setFileInputKey(key => key + 1);
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

      <label>تصميم الجولة للموظفين</label>
      <select value={themeKey} onChange={e=>setThemeKey(e.target.value)}>
        {THEME_OPTIONS.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <small className="hint">يمكنك تركه تلقائيًا أو اختيار هوية ثابتة تناسب المطعم.</small>

      <label>اسم اختياري للجولة</label>
      <input maxLength="100" placeholder="مثلاً: غداء يوم الثلاثاء" value={title} onChange={e => setTitle(e.target.value)} />

      <label>موعد إغلاق الطلبات</label>
      <input type="datetime-local" min={new Date().toISOString().slice(0, 16)} value={deadline} onChange={e => setDeadline(e.target.value)} />

      <label>صور أو ملفات منيو المطعم (اختياري)</label>
      <input key={fileInputKey} id="round-menu-file" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => {
        const selected = Array.from(e.target.files || []);
        setFiles(current => {
          const seen = new Set(current.map(file => `${file.name}:${file.size}:${file.lastModified}`));
          return [...current, ...selected.filter(file => !seen.has(`${file.name}:${file.size}:${file.lastModified}`))];
        });
        e.target.value = '';
      }} />
      <small className="hint">يمكنك اختيار عدة صور أو ملفات PDF، بحد أقصى 12 ملفًا و10 ميجابايت لكل ملف.</small>
      {files.length > 0 && <div className="selected-files-list">
        {files.map((file, index) => <div className="selected-file-row" key={`${file.name}-${file.lastModified}-${index}`}>
          <span>{file.type.startsWith('image/') ? '🖼️' : '📄'} {file.name}</span>
          <button type="button" className="remove-link" onClick={() => setFiles(current => current.filter((_, i) => i !== index))}>إزالة</button>
        </div>)}
      </div>}

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

function MenuItemPicker({ menuItems = [], item, onChange }) {
  const selected = menuItems.find(row => row.name === item.description);
  const [category, setCategory] = useState(selected?.category || '');
  const [species, setSpecies] = useState(selected?.subcategory || '');
  useEffect(() => {
    if (selected) {
      setCategory(selected.category || 'أصناف أخرى');
      setSpecies(selected.subcategory || '');
    }
  }, [selected?.id]);
  const categories = [...new Set(menuItems.map(row => row.category || 'أصناف أخرى'))]
    .sort((a,b) => MENU_CATEGORIES.indexOf(a)-MENU_CATEGORIES.indexOf(b));
  const inCategory = menuItems.filter(row => (row.category || 'أصناف أخرى') === category);
  const speciesList = [...new Set(inCategory.map(row => row.subcategory).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  const choose = value => value === '__custom__'
    ? onChange({ description: '', customRequest: true, variant: '' })
    : onChange({ description: value, customRequest: false, variant: '' });
  return <div style={{display:'grid',gap:8}}>
    <select required value={category} onChange={e=>{setCategory(e.target.value);setSpecies('');onChange({description:'',customRequest:false});}}>
      <option value="">اختر القسم</option>
      {categories.map(value=><option key={value}>{value}</option>)}
    </select>
    {category === 'السمك' ? <>
      <select required value={species} onChange={e=>{setSpecies(e.target.value);onChange({description:'',customRequest:false});}}>
        <option value="">اختر نوع السمك</option>
        {speciesList.map(value=><option key={value}>{value}</option>)}
      </select>
      <select required value={selected?.category === 'السمك' && selected.subcategory === species ? selected.name : ''} onChange={e=>choose(e.target.value)}>
        <option value="">اختر طريقة التسوية</option>
        {inCategory.filter(row=>row.subcategory===species).map(row=><option key={row.id} value={row.name}>{row.preparation || row.name}</option>)}
        <option value="__custom__">الصنف غير موجود — طلب إضافته</option>
      </select>
    </> : category === 'الجمبري' ? <select required value={selected?.category === 'الجمبري' ? selected.name : ''} onChange={e=>choose(e.target.value)}>
      <option value="">اختر طريقة تحضير الجمبري</option>
      {inCategory.map(row=><option key={row.id} value={row.name}>{row.preparation || row.name.replace(/^جمبري\s*[—-]?\s*/,'')}</option>)}
      <option value="__custom__">الصنف غير موجود — طلب إضافته</option>
    </select> : <select required value={selected && selected.category === category ? selected.name : ''} onChange={e=>choose(e.target.value)}>
      <option value="">اختر الصنف</option>
      {inCategory.map(row=><option key={row.id} value={row.name}>{row.name}</option>)}
      <option value="__custom__">الصنف غير موجود — طلب إضافته</option>
    </select>}
    {selected?.weight_options?.length > 0 && <label>{selected.weight_options.includes('Single') ? 'اختر حجم البرجر' : 'الوزن / الحجم'}
      <select required value={item.variant || ''} onChange={e=>onChange({variant:e.target.value})}>
        <option value="">اختر {selected.weight_options.includes('Single') ? 'الحجم' : 'الوزن'}</option>
        {selected.weight_options.map(weight=><option key={weight} value={weight}>{weight}</option>)}
      </select>
    </label>}
  </div>;
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

  const menuPaths = round?.menu_paths?.length ? round.menu_paths : (round?.menu_path ? [round.menu_path] : []);
  const resolvedTheme = resolveTheme(round);
  const themeClass = `theme-${resolvedTheme}`;
  const themePresentation = THEME_PRESENTATION[resolvedTheme] || THEME_PRESENTATION.general;
  const employeeSuggestions = name.trim().length >= 2
    ? (round?.employee_names || []).filter(person => person.toLocaleLowerCase('ar').startsWith(name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ar'))).slice(0, 6)
    : [];
  const menuUrls = menuPaths.map(path => ({ path, url: supabase.storage.from('round-menus').getPublicUrl(path).data.publicUrl }));

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
    return <div className={`guest-wrap ${themeClass}`}>
      <div className="guest-brand"><Logo /><span>HALL NO. 213</span></div>
      <div className={`guest-theme-banner ${themeClass}`}><span className="guest-theme-icon" aria-hidden="true">{themePresentation.icon}</span><div><b>{themePresentation.label}</b><small>{themePresentation.note}</small></div></div>
      <div className="guest-card card success-card">
        <div className="success-icon">✓</div>
        <h1>طلبك وصل!</h1>
        <p>تم تسجيل طلبك بنجاح. تقدر تقفل الصفحة دلوقتي.</p>
      </div>
      <p className="guest-foot">United We Eat. Divided We Pay.</p>
    </div>;
  }

  return <div className={`guest-wrap ${themeClass}`}>
    <div className="guest-brand"><Logo /><span>HALL NO. 213</span></div>
      <div className={`guest-theme-banner ${themeClass}`}><span className="guest-theme-icon" aria-hidden="true">{themePresentation.icon}</span><div><b>{themePresentation.label}</b><small>{themePresentation.note}</small></div></div>

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
        {menuUrls.length > 0 && <div className="menu-links">
          {menuUrls.map((item, index) => <a className="menu-link" key={item.path} href={item.url} target="_blank" rel="noreferrer">📎 عرض ملف المنيو {index + 1}</a>)}
        </div>}

        <form onSubmit={submit}>
          <label htmlFor="guest-employee-name">اسمك</label>
          <input id="guest-employee-name" required minLength="2" maxLength="100" autoComplete="off" value={name} onChange={e => setName(e.target.value)} placeholder="اكتب اسمك الأول أو أول اسمين" />
          {employeeSuggestions.length > 0 && <div className="employee-suggestions" role="listbox" aria-label="الأسماء المطابقة">
            {employeeSuggestions.map(person => <button type="button" role="option" key={person} onClick={() => setName(person)}>{person}</button>)}
          </div>}
          {name.trim().length >= 2 && employeeSuggestions.length === 0 && <small className="employee-name-hint">لا توجد أسماء مطابقة — أكمل كتابة اسمك بالكامل.</small>}

          <div className="form-divider" />
          <div className="items-title"><b>الأصناف المطلوبة</b><small>أضف كل صنف في سطر مستقل</small></div>

          {items.map((item, index) => <div className="guest-item" key={item.key}>
            <div className="item-top">
              <b>صنف {index + 1}</b>
              {items.length > 1 && <button type="button" className="remove-link" onClick={() => setItems(old => old.filter(x => x.key !== item.key))}>حذف</button>}
            </div>

            {round.menu_items?.length ? <MenuItemPicker menuItems={round.menu_items} item={item} onChange={patch=>patchItem(item.key,patch)} /> : <input required value={item.description} maxLength="180" onChange={e => patchItem(item.key, { description: e.target.value })} placeholder="مثلاً: سمك مشوي، أرز صيادية..." />}
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

const MENU_CATEGORIES = ['السلطات','الأرز والأطباق الجانبية','السمك','الجمبري','الطواجن','الوجبات','الشوربات','السندوتشات','أصناف أخرى'];
const BISTRO_MENU_CATEGORIES = ['برجر لحم','برجر دجاج','سندوتشات الردة','حواوشي','وجبات','بيتزا','أصناف أخرى'];

function RestaurantMenuPanel({round,restaurants=[],onAssign,busy,onAdd,onSaveItem,onDeleteItem,onImportRoundItems,onApprove,onDismiss,onCreateMenu,onRenameMenu,onDeleteMenu,onAddCategory,onRenameCategory,onDeleteCategory}) {
 const [newMenu,setNewMenu]=useState(''),[newCat,setNewCat]=useState(''),[name,setName]=useState(''),[category,setCategory]=useState(''),[sub,setSub]=useState(''),[prep,setPrep]=useState(''),[weights,setWeights]=useState([]),[error,setError]=useState('');
 const restaurantName=restaurants.find(r=>r.id===round.restaurant_id)?.name||'';
 const currentMenuName=round.menus?.find(m=>m.id===round.menu_id)?.name||'';
 const isBistro=restaurantName.trim().toLowerCase()==='bistro'||currentMenuName.trim().toLowerCase()==='bistro';
 const fallbackCategories=isBistro?BISTRO_MENU_CATEGORIES:MENU_CATEGORIES;
 const cats=round.menuCategories?.length?round.menuCategories:fallbackCategories.map((name,i)=>({name,sort_order:i}));
 const categoryKey=cats.map(c=>c.name).join('|');
 useEffect(()=>{if(!cats.some(c=>c.name===category))setCategory(cats[0]?.name||'');},[round.menu_id,categoryKey,category]);
 const isFish=!isBistro&&category==='السمك';
 const isShrimp=!isBistro&&category==='الجمبري';
 const isBurger=isBistro&&/برجر|burger/i.test(category);
 const run=async fn=>{try{setError('');await fn();}catch(e){setError(e.message||'تعذر تنفيذ العملية');}};
 const itemName=isFish?['سمك '+sub,prep].filter(Boolean).join(' — '):isShrimp?['جمبري',prep].filter(Boolean).join(' — ').trim():name.trim();
 return <div className="panel card">
 <div className="panel-title"><div><h3>إدارة المنيو</h3><p className="muted">تحكم كامل في المنيوهات والأقسام والأصناف والأوزان.</p></div></div>
 <section className="sub-panel" style={{display:'grid',gap:8,border:'1px solid var(--line)',borderRadius:12,padding:12}}>
 <b>المطعم المرتبط بهذه الجولة</b>
 <select value={round.restaurant_id||''} onChange={e=>e.target.value&&run(()=>onAssign(e.target.value,''))}>
  <option value="">اختر مطعماً</option>{restaurants.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
 </select>
 </section>
 {!round.restaurant_id?<div className="empty-inline">اختر المطعم لعرض منيوه.</div>:<>
 <section className="sub-panel" style={{display:'grid',gap:8,border:'1px solid var(--line)',borderRadius:12,padding:12}}>
 <b>منيوهات المطعم</b>
 <select value={round.menu_id||''} onChange={e=>run(()=>onAssign(round.restaurant_id,e.target.value))}>{(round.menus||[]).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select>
 <div className="inline-actions"><input value={newMenu} onChange={e=>setNewMenu(e.target.value)} placeholder="اسم المنيو الجديد"/><button type="button" className="primary small-btn" disabled={!newMenu.trim()} onClick={()=>run(async()=>{await onCreateMenu(newMenu.trim());setNewMenu('');})}>إنشاء</button></div>
 <div className="inline-actions"><button type="button" className="secondary small-btn" onClick={()=>{const v=prompt('اسم المنيو:',round.menus?.find(m=>m.id===round.menu_id)?.name||'');if(v?.trim())run(()=>onRenameMenu(round.menu_id,v.trim()));}}>تعديل الاسم</button><button type="button" className="text-btn danger" disabled={(round.menus||[]).length<2} onClick={()=>confirm('حذف المنيو؟ لن تتأثر الفواتير القديمة.')&&run(()=>onDeleteMenu(round.menu_id))}>حذف المنيو</button></div>
 </section>
 <section style={{display:'grid',gap:8,marginTop:14}}><b>الأقسام الرئيسية</b>
 {cats.map(c=><div className="inline-actions" key={c.id||c.name} style={{justifyContent:'space-between'}}><span>{c.name}</span><span><button className="text-btn" onClick={()=>{const v=prompt('اسم القسم الجديد:',c.name);if(v?.trim())run(()=>onRenameCategory(c.id,c.name,v.trim()));}}>تعديل</button> <button className="text-btn danger" onClick={()=>confirm('حذف القسم ونقل أصنافه إلى أصناف أخرى؟')&&run(()=>onDeleteCategory(c.id,c.name))}>حذف</button></span></div>)}
 <div className="inline-actions"><input value={newCat} onChange={e=>setNewCat(e.target.value)} placeholder="إضافة قسم رئيسي"/><button className="secondary small-btn" onClick={()=>run(async()=>{await onAddCategory(newCat.trim());setNewCat('');})} disabled={!newCat.trim()}>إضافة قسم</button></div></section>
 <form onSubmit={e=>{e.preventDefault();if(!itemName.trim())return;run(async()=>{await onAdd({name:itemName,category,subcategory:sub,preparation:prep,weight_options:weights.length?weights:(isFish?['سمكة واحدة','نصف كيلو','كيلو']:isShrimp?['ربع كيلو','نصف كيلو','كيلو']:isBurger?['Single','Double']:[])});setName('');setSub('');setPrep('');setWeights([]);});}} style={{display:'grid',gap:9,marginTop:16,padding:12,border:'1px solid var(--line)',borderRadius:12}}>
 <b>إضافة صنف رئيسي أو فرعي</b><label>القسم<select value={category} onChange={e=>setCategory(e.target.value)}>{cats.map(c=><option key={c.id||c.name}>{c.name}</option>)}</select></label>
 {isFish?<><label>نوع السمك<input required value={sub} onChange={e=>setSub(e.target.value)} placeholder="بوري، بلطي، دنيس..."/></label><label>طريقة التسوية<select required value={prep} onChange={e=>setPrep(e.target.value)}><option value="">اختر</option>{['مشوي','سنجاري','زيت وليمون','مقلي','بطاطس كريمة'].map(x=><option key={x}>{x}</option>)}</select></label></>:isShrimp?<label>طريقة التحضير<select required value={prep} onChange={e=>setPrep(e.target.value)}><option value="">اختر</option>{['طاجن أحمر','طاجن وايت صوص','طاجن ميكس مع سبيط','مشوي','مقلي'].map(x=><option key={x}>{x}</option>)}</select></label>:<label>اسم الصنف<input required value={name} onChange={e=>setName(e.target.value)}/></label>}
 {(isFish||isShrimp)&&<div><b>الأوزان المتاحة</b>{(isFish?['سمكة واحدة','نصف كيلو','كيلو']:['ربع كيلو','نصف كيلو','كيلو']).map(w=><label key={w} style={{display:'block'}}><input type="checkbox" checked={weights.includes(w)} onChange={e=>setWeights(old=>e.target.checked?[...old,w]:old.filter(x=>x!==w))}/> {w}</label>)}</div>}
 {isBurger&&<div><b>أحجام البرجر</b>{['Single','Double'].map(w=><label key={w} style={{display:'block'}}><input type="checkbox" checked={weights.includes(w)} onChange={e=>setWeights(old=>e.target.checked?[...old,w]:old.filter(x=>x!==w))}/> {w}</label>)}</div>}
 <button className="primary" disabled={busy}>إضافة الصنف</button></form>
 {error&&<div className="inline-error">{error}</div>}
 <div style={{display:'grid',gap:12,marginTop:16}}>{cats.map(c=>{const rows=(round.menuItems||[]).filter(x=>(x.category||'أصناف أخرى')===c.name);return rows.length?<section key={c.id||c.name} style={{border:'1px solid var(--line)',borderRadius:12,padding:10}}><h4>{c.name}</h4>{rows.map(x=><div key={x.id} className="inline-actions" style={{justifyContent:'space-between',padding:'7px 0'}}><span><b>{x.name}</b><small style={{display:'block'}}>{(x.weight_options||[]).join(' · ')}</small></span><span><button className="text-btn" onClick={()=>{const v=prompt('تعديل اسم الصنف:',x.name);if(v?.trim())run(()=>onSaveItem({...x,name:v.trim()}));}}>الاسم</button> <button className="text-btn" onClick={()=>{const v=prompt('الأسعار: السعر العادي أو Single,Double:',x.weight_options?.includes('Single')?`${x.single_price??''},${x.double_price??''}`:(x.default_price??''));if(v!==null){const parts=v.split(/[،,]/).map(t=>t.trim());run(()=>onSaveItem(x.weight_options?.includes('Single')?{...x,single_price:parts[0]===''?null:Number(parts[0]),double_price:parts[1]===''?null:Number(parts[1])}:{...x,default_price:parts[0]===''?null:Number(parts[0])}));}}}>الأسعار</button> <button className="text-btn" onClick={()=>{const v=prompt('الأوزان/الاختيارات مفصولة بفاصلة:',(x.weight_options||[]).join('، '));if(v!==null)run(()=>onSaveItem({...x,weight_options:v.split(/[،,]/).map(t=>t.trim()).filter(Boolean)}));}}>الأوزان/الاختيارات</button> <button className="text-btn danger" onClick={()=>confirm('إزالة الصنف من المنيو؟')&&run(()=>onDeleteItem(x))}>إزالة</button></span></div>)}</section>:null;})}</div>
 <button type="button" className="secondary small-btn" onClick={()=>run(onImportRoundItems)}>استخراج أصناف الجولة الحالية</button>
 <h4>طلبات الموظفين لإضافة أصناف</h4>{(round.menuRequests||[]).map(r=><div className="inline-actions" key={r.id}><span>{r.requested_name} — {r.requested_by_name}</span><button className="primary small-btn" onClick={()=>run(()=>onApprove(r))}>اعتماد</button><button className="text-btn danger" onClick={()=>run(()=>onDismiss(r))}>رفض</button></div>)}
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