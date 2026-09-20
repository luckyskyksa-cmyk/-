(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let currentCustomerId = null;
  let searchTimer = null;

  // --- أدوات مساعدة ---
  const fmt = new Intl.NumberFormat('ar-EG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const money = (n) => fmt.format(Number(n) || 0);

  function toast(msg, type) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast ' + (type || '');
    setTimeout(() => el.classList.add('hidden'), 2600);
  }

  async function api(path, options = {}) {
    const res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options,
    });
    if (res.status === 401) {
      showLogin();
      throw new Error('unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'حدث خطأ');
    }
    return data;
  }

  // --- شاشات ---
  function showLogin() {
    $('#login-screen').classList.remove('hidden');
    $('#app').classList.add('hidden');
  }
  function showApp() {
    $('#login-screen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    refreshAll();
  }

  // --- تسجيل الدخول ---
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await api('/login', {
        method: 'POST',
        body: JSON.stringify({ password: $('#password').value }),
      });
      $('#password').value = '';
      showApp();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  $('#backup-btn').addEventListener('click', () => {
    window.location.href = '/api/backup';
  });

  // --- تحديث البيانات ---
  async function refreshAll() {
    await Promise.all([loadSummary(), loadCustomers()]);
  }

  async function loadSummary() {
    try {
      const s = await api('/summary');
      $('#stat-outstanding').textContent = money(s.totalOutstanding);
      $('#stat-customers').textContent = money(s.customersCount);
      $('#stat-debts').textContent = money(s.totalDebts);
      $('#stat-payments').textContent = money(s.totalPayments);
    } catch (_) {}
  }

  function balanceClass(b) {
    if (b > 0) return 'positive';
    if (b < 0) return 'negative';
    return 'zero';
  }

  async function loadCustomers() {
    const search = $('#search-input').value.trim();
    const q = search ? '?search=' + encodeURIComponent(search) : '';
    let customers;
    try {
      customers = await api('/customers' + q);
    } catch (_) {
      return;
    }
    const tbody = $('#customers-tbody');
    tbody.innerHTML = '';
    if (customers.length === 0) {
      $('#empty-state').classList.remove('hidden');
    } else {
      $('#empty-state').classList.add('hidden');
    }
    for (const c of customers) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="customer-name">${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.phone) || '—'}</td>
        <td class="balance ${balanceClass(c.balance)}">${money(c.balance)}</td>
        <td>عرض ‹</td>
      `;
      tr.addEventListener('click', () => openDetail(c.id));
      tbody.appendChild(tr);
    }
  }

  $('#search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadCustomers, 250);
  });

  // --- نافذة العميل (إضافة/تعديل) ---
  function openCustomerModal(customer) {
    $('#customer-form-error').textContent = '';
    if (customer) {
      $('#customer-modal-title').textContent = 'تعديل عميل';
      $('#customer-id').value = customer.id;
      $('#customer-name').value = customer.name;
      $('#customer-phone').value = customer.phone || '';
      $('#customer-note').value = customer.note || '';
    } else {
      $('#customer-modal-title').textContent = 'إضافة عميل';
      $('#customer-form').reset();
      $('#customer-id').value = '';
    }
    $('#customer-modal').classList.remove('hidden');
    $('#customer-name').focus();
  }

  $('#add-customer-btn').addEventListener('click', () => openCustomerModal(null));

  $('#customer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#customer-form-error').textContent = '';
    const id = $('#customer-id').value;
    const payload = {
      name: $('#customer-name').value,
      phone: $('#customer-phone').value,
      note: $('#customer-note').value,
    };
    try {
      if (id) {
        await api('/customers/' + id, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        toast('تم تحديث بيانات العميل', 'success');
      } else {
        await api('/customers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast('تمت إضافة العميل', 'success');
      }
      closeModal('#customer-modal');
      await refreshAll();
      if (id && currentCustomerId) openDetail(currentCustomerId);
    } catch (err) {
      $('#customer-form-error').textContent = err.message;
    }
  });

  // --- نافذة التفاصيل ---
  async function openDetail(id) {
    currentCustomerId = id;
    let data;
    try {
      data = await api('/customers/' + id);
    } catch (_) {
      return;
    }
    $('#detail-name').textContent = data.name;
    $('#detail-phone').textContent = data.phone
      ? '📞 ' + data.phone
      : (data.note || '');
    const bal = $('#detail-balance');
    bal.textContent = money(data.balance);
    bal.className = 'balance ' + balanceClass(data.balance);
    $('#tx-date').value = new Date().toISOString().slice(0, 10);
    $('#tx-amount').value = '';
    $('#tx-note').value = '';
    $('#tx-form-error').textContent = '';
    renderTransactions(data.transactions);
    $('#detail-modal').classList.remove('hidden');
  }

  function renderTransactions(transactions) {
    const tbody = $('#tx-tbody');
    tbody.innerHTML = '';
    if (!transactions || transactions.length === 0) {
      $('#tx-empty').classList.remove('hidden');
      return;
    }
    $('#tx-empty').classList.add('hidden');
    for (const t of transactions) {
      const tr = document.createElement('tr');
      const typeLabel = t.type === 'debt' ? 'دين' : 'تسديد';
      tr.innerHTML = `
        <td>${escapeHtml(t.date)}</td>
        <td><span class="pill ${t.type}">${typeLabel}</span></td>
        <td>${money(t.amount)}</td>
        <td>${escapeHtml(t.note) || '—'}</td>
        <td><button class="icon-btn" title="حذف">🗑</button></td>
      `;
      tr.querySelector('.icon-btn').addEventListener('click', () =>
        deleteTransaction(t.id)
      );
      tbody.appendChild(tr);
    }
  }

  async function addTransaction(type) {
    $('#tx-form-error').textContent = '';
    const payload = {
      amount: $('#tx-amount').value,
      type,
      note: $('#tx-note').value,
      date: $('#tx-date').value,
    };
    try {
      await api('/customers/' + currentCustomerId + '/transactions', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast(type === 'debt' ? 'تم تسجيل الدين' : 'تم تسجيل التسديد', 'success');
      await openDetail(currentCustomerId);
      await loadSummary();
      await loadCustomers();
    } catch (err) {
      $('#tx-form-error').textContent = err.message;
    }
  }

  $$('#transaction-form .tx-buttons .btn').forEach((btn) => {
    btn.addEventListener('click', () => addTransaction(btn.dataset.type));
  });

  async function deleteTransaction(txId) {
    if (!confirm('هل تريد حذف هذه الحركة؟')) return;
    try {
      await api('/transactions/' + txId, { method: 'DELETE' });
      toast('تم حذف الحركة', 'success');
      await openDetail(currentCustomerId);
      await loadSummary();
      await loadCustomers();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  $('#edit-customer-btn').addEventListener('click', async () => {
    try {
      const data = await api('/customers/' + currentCustomerId);
      openCustomerModal(data);
    } catch (_) {}
  });

  $('#delete-customer-btn').addEventListener('click', async () => {
    if (!confirm('هل تريد حذف العميل وجميع حركاته؟ لا يمكن التراجع.')) return;
    try {
      await api('/customers/' + currentCustomerId, { method: 'DELETE' });
      toast('تم حذف العميل', 'success');
      closeModal('#detail-modal');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // --- إغلاق النوافذ ---
  function closeModal(sel) {
    $(sel).classList.add('hidden');
  }
  $$('[data-close]').forEach((el) => {
    el.addEventListener('click', () => {
      el.closest('.modal').classList.add('hidden');
    });
  });
  $$('.modal').forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- بدء التشغيل: تحقق من الجلسة ---
  (async function init() {
    try {
      await api('/summary');
      showApp();
    } catch (_) {
      showLogin();
    }
  })();
})();
