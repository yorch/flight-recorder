const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const comments = [];
const orders = [];
const carts = new Map();
let cartId = 0;
const profile = { name: 'Alex Morgan', theme: 'light' };
const products = [
  { id: 'notebook', name: 'Editorial notebook', price: 1800 },
  { id: 'mug', name: 'BlogHub mug', price: 1400 },
  { id: 'tote', name: 'Reader tote', price: 2200 },
];
const money = (n) => `$${(n / 100).toFixed(2)}`;
export const enrichPost = (post) => {
  post.created_at = new Date().toISOString();
  post.tags = ['Journal'];
};
export function layout(title, body, toast = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · BlogHub</title><style>
  *{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:${profile.theme === 'dark' ? '#172338' : '#f5f7fb'};color:${profile.theme === 'dark' ? '#edf2fa' : '#24324b'};font:16px/1.55 system-ui,sans-serif}header{background:#fff;color:#24324b;border-bottom:1px solid #dfe5ef;padding:20px 5%;display:flex;align-items:center;gap:36px}header strong{font-size:24px;color:#4358cd}nav{display:flex;gap:22px;flex-wrap:wrap}a{color:#4358cd;text-underline-offset:3px}main{max-width:1120px;margin:36px auto;padding:0 24px}h1{font-size:32px;margin:0 0 22px}h2{font-size:22px}form,.card,article,section.panel{background:#fff;color:#24324b;padding:24px;border:1px solid #dfe5ef;border-radius:12px;margin:16px 0}label{display:block;font-weight:600;margin:12px 0 6px}input:not([type=checkbox]),textarea,select{display:block;padding:11px;border:1px solid #aab7cb;border-radius:6px;font:inherit;width:100%;max-width:600px}textarea{min-height:120px}button,.button{display:inline-block;background:#4358cd;color:#fff;border:0;border-radius:6px;padding:10px 17px;font:inherit;margin:6px 4px 6px 0}button:hover,.button:hover{background:#3043aa}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #df9d20;outline-offset:3px}table{width:100%;border-collapse:collapse;background:#fff;color:#24324b}th,td{text-align:left;padding:14px;border-bottom:1px solid #e1e7f0}td form{display:inline;padding:0;border:0;margin:0}td button{font-size:14px;padding:6px 10px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}.muted{color:#65758b}.badge{background:#edf0ff;color:#3647ab;border-radius:20px;padding:4px 10px;font-size:13px}.toast{background:#dcf6e7;color:#165335;padding:14px;border-radius:8px;position:sticky;top:8px;z-index:2}img{max-width:100%;max-height:320px;object-fit:contain}dialog{border:1px solid #b5c0d1;border-radius:12px;max-width:460px;padding:28px}dialog::backdrop{background:#17233888}footer{max-width:1120px;margin:48px auto;padding:24px;color:#65758b}.error{color:#af2534;display:block}p.prose{white-space:pre-wrap}input[type=checkbox]{width:18px;height:18px}
  </style></head><body><header><strong>BlogHub</strong><nav aria-label="Main navigation"><a href="/dashboard">Dashboard</a><a href="/admin/posts">Posts</a><a href="/admin/comments">Comments</a><a href="/admin/settings">Settings</a><a href="/blog">Blog</a><a href="/store">Store</a><a href="/cart">Cart</a><a href="/validation">Contact</a></nav></header><main>${toast ? `<div class="toast" role="status">${esc(toast)}</div>` : ''}${body}</main><script>const notice=sessionStorage.getItem('bloghub_notice');if(notice){sessionStorage.removeItem('bloghub_notice');const toast=document.createElement('div');toast.className='toast';toast.setAttribute('role','status');toast.textContent=notice;document.querySelector('main').prepend(toast);}</script><footer>BlogHub · A small home for big ideas</footer></body></html>`;
}
const action = (url, text) => `<form method="post" action="${url}"><button>${text}</button></form>`;
const search = (label, q) =>
  `<form method="get" role="search"><label>${label}<input type="search" name="q" value="${esc(q)}"></label><button>Search</button></form>`;
export function productRoutes(req, res, u, posts, rec, body) {
  const p = u.pathname;
  const send = (title, html, toast = '') => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(title, html, toast || u.searchParams.get('notice')));
    return true;
  };
  const redirect = (url, notice) => {
    res.writeHead(303, { location: `${url}${notice ? `${url.includes('?') ? '&' : '?'}notice=${encodeURIComponent(notice)}` : ''}` }).end();
    return true;
  };
  const mutation = (msg, fields) => rec({ proto: 'server', msg, ...fields });
  const q = new URLSearchParams(body === undefined ? '' : Buffer.from(body, 'latin1').toString('utf8'));
  const matched = /^\/admin\/posts\/([a-z0-9-]+)\/(edit|delete|duplicate|toggle)$/.exec(p);
  const post = matched && posts.find((x) => x.slug === matched[1]);
  if (body !== undefined) {
    if (post) {
      const kind = matched[2];
      if (kind === 'edit') {
        post.title = q.get('title') ?? post.title;
        post.body = q.get('body') ?? post.body;
        post.published = q.has('published');
        post.tags = (q.get('tags') || 'Journal')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
      }
      if (kind === 'delete') posts.splice(posts.indexOf(post), 1);
      if (kind === 'toggle') post.published = !post.published;
      let changed = post;
      if (kind === 'duplicate') {
        changed = { ...post, slug: `${post.slug}-copy-${Date.now()}`, title: `${post.title} (copy)`, published: false };
        changed.created_at = new Date().toISOString();
        posts.push(changed);
      }
      mutation({ edit: 'post_edited', delete: 'post_deleted', toggle: 'post_status_changed', duplicate: 'post_duplicated' }[kind], {
        slug: changed.slug,
        title: changed.title,
        published: changed.published,
        tags: changed.tags,
      });
      return redirect(
        '/admin/posts',
        { edit: 'Post saved', delete: 'Post deleted', toggle: 'Publication status updated', duplicate: 'Post duplicated' }[kind],
      );
    }
    if (p === '/comments') {
      const target = posts.find((x) => x.slug === q.get('slug'));
      if (!target || !q.get('author')?.trim() || !q.get('comment')?.trim()) {
        res.writeHead(400).end('Author and comment are required');
        return true;
      }
      const comment = { id: comments.length + 1, slug: target.slug, author: q.get('author'), comment: q.get('comment'), status: 'pending' };
      comments.push(comment);
      mutation('comment_added', comment);
      return redirect(`/blog/${target.slug}`, 'Comment submitted for moderation');
    }
    if (p === '/admin/comments') {
      const comment = comments.find((x) => x.id === Number(q.get('id')));
      if (comment && ['approved', 'rejected'].includes(q.get('status'))) {
        comment.status = q.get('status');
        mutation('comment_moderated', comment);
      }
      return redirect(p, 'Moderation saved');
    }
    if (p === '/admin/settings' || p === '/settings') {
      profile.name = q.get('name') || profile.name;
      profile.theme = q.get('theme') === 'dark' ? 'dark' : 'light';
      mutation('settings_saved', { display_name: profile.name, theme: profile.theme });
      return redirect(p, 'Settings saved');
    }
  }
  let id = /(?:^|;\s*)bloghub_cart=(\d+)/.exec(req.headers.cookie || '')?.[1];
  if (['/store', '/cart', '/checkout'].includes(p)) {
    if (!id || !carts.has(id)) {
      id = String(++cartId);
      carts.set(id, []);
      res.setHeader('Set-Cookie', `bloghub_cart=${id}; Path=/; HttpOnly; SameSite=Lax`);
    }
    const cart = carts.get(id);
    const total = cart.reduce((sum, x) => sum + x.price, 0);
    if (body !== undefined && p === '/cart') {
      const product = products.find((x) => x.id === q.get('product'));
      if (q.get('action') === 'clear') cart.length = 0;
      else if (product) cart.push(product);
      mutation('cart_updated', { cart_id: id, product_id: product?.id, item_count: cart.length });
      return redirect('/cart', 'Cart updated');
    }
    if (body !== undefined && p === '/checkout') {
      if (!cart.length || !q.get('name')?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.get('email') || '') || !q.get('address')?.trim()) {
        res.writeHead(400).end('A cart, name, valid email and address are required');
        return true;
      }
      const order = {
        order_id: `BH-${String(orders.length + 1).padStart(5, '0')}`,
        customer: q.get('name'),
        email: q.get('email'),
        address: q.get('address'),
        items: cart.map((x) => ({ ...x })),
        total_cents: total,
      };
      orders.push(order);
      cart.length = 0;
      mutation('order_created', order);
      return redirect(`/orders/${order.order_id}`);
    }
    if (body !== undefined) return false;
    if (p === '/store')
      return send(
        'Store',
        `<h1>The BlogHub shop</h1><p>Thoughtful essentials for writers and readers.</p><div class="grid">${products.map((x) => `<article><span class="badge">Writer essentials</span><h2>${x.name}</h2><p>${money(x.price)}</p><form method="post" action="/cart"><input type="hidden" name="product" value="${x.id}"><button>Add ${x.name} to cart</button></form></article>`).join('')}</div>`,
      );
    if (p === '/cart')
      return send(
        'Cart',
        `<h1>Your cart</h1>${cart.length ? `<ul>${cart.map((x) => `<li>${x.name} — ${money(x.price)}</li>`).join('')}</ul><p>Total: ${money(total)}</p><a class="button" href="/checkout">Checkout</a><form method="post"><input type="hidden" name="action" value="clear"><button>Clear cart</button></form>` : '<p>Your cart is empty.</p><a href="/store">Browse products</a>'}`,
      );
    return send(
      'Checkout',
      `<h1>Checkout</h1><p>${cart.length} items · ${money(total)}</p><form method="post"><label>Full name<input name="name" required autocomplete="name"></label><label>Email<input name="email" type="email" required autocomplete="email"></label><label>Shipping address<textarea name="address" required autocomplete="street-address"></textarea></label><p>This demo checkout requires no payment details.</p><button>Place order</button></form>`,
    );
  }
  if (body !== undefined) return false;
  if (p.startsWith('/orders/')) {
    const order = orders.find((x) => `/orders/${x.order_id}` === p);
    if (!order) return false;
    return send(
      'Order confirmation',
      `<h1>Thank you for your order</h1><p role="status">Order confirmed: <strong>${order.order_id}</strong></p><p>Total ${money(order.total_cents)}</p><a href="/store">Continue shopping</a>`,
    );
  }
  if (post && matched[2] === 'edit')
    return send(
      'Edit post',
      `<h1>Edit post</h1><form method="post"><label>Title<input name="title" value="${esc(post.title)}" required></label><label>Body<textarea name="body">${esc(post.body)}</textarea></label><label>Tags<input name="tags" value="${esc(post.tags?.join(', '))}"></label><label><input type="checkbox" name="published" ${post.published ? 'checked' : ''}> Published</label><button>Save</button></form>`,
    );
  if (p === '/dashboard' || p === '/admin')
    return send(
      'Dashboard',
      `<h1>Dashboard</h1><p>Welcome back, ${esc(profile.name)}. Here’s your publication at a glance.</p><div class="grid">${[
        ['Total posts', posts.length],
        ['Published', posts.filter((x) => x.published).length],
        ['Drafts', posts.filter((x) => !x.published).length],
      ]
        .map(([label, value]) => `<section class="panel" aria-label="${label}"><h2>${label}</h2><strong>${value}</strong></section>`)
        .join('')}</div><section class="panel" aria-label="Recent posts"><h2>Recent posts</h2>${
        posts
          .slice(-5)
          .reverse()
          .map((x) => `<p><a href="/admin/posts/${x.slug}/edit">${esc(x.title)}</a></p>`)
          .join('') || '<p>No posts yet. Start your first story.</p>'
      }<a class="button" href="/admin/posts/new">New post</a></section><section class="panel" aria-label="Recent orders"><h2>Recent orders</h2>${orders.map((x) => `<p>${x.order_id} · ${money(x.total_cents)}</p>`).join('') || '<p>No orders yet</p>'}</section>`,
    );
  if (p === '/admin/posts') {
    const term = u.searchParams.get('q') || '';
    const sort = u.searchParams.get('sort') || 'date';
    const direction = u.searchParams.get('dir') === 'desc' ? -1 : 1;
    const filtered = posts
      .filter((x) => x.title.toLowerCase().includes(term.toLowerCase()))
      .sort(
        (a, b) =>
          direction *
          String(sort === 'title' ? a.title : sort === 'status' ? a.published : a.created_at).localeCompare(
            String(sort === 'title' ? b.title : sort === 'status' ? b.published : b.created_at),
          ),
      );
    const pages = Math.max(1, Math.ceil(filtered.length / 5));
    const current = Math.min(pages, Math.max(1, Math.floor(Number(u.searchParams.get('page'))) || 1));
    const url = (extra) => `/admin/posts?${new URLSearchParams({ q: term, sort, dir: direction === 1 ? 'asc' : 'desc', ...extra })}`;
    return send(
      'Admin posts',
      `<h1>Admin posts</h1><a class="button" href="/admin/posts/new">New post</a>${search('Search posts', term)}<table><caption>Posts · ${filtered.length} results</caption><thead><tr>${[
        ['title', 'Title'],
        ['status', 'Status'],
        ['date', 'Date'],
      ]
        .map(
          ([key, label]) => `<th scope="col"><a href="${esc(url({ sort: key, dir: direction === 1 ? 'desc' : 'asc' }))}">${label}</a></th>`,
        )
        .join('')}<th scope="col">Actions</th></tr></thead><tbody>${
        filtered
          .slice((current - 1) * 5, current * 5)
          .map(
            (x) =>
              `<tr><td>${esc(x.title)}</td><td><span class="badge">${x.published ? 'Published' : 'Draft'}</span></td><td>${esc(x.created_at?.slice(0, 10))}</td><td><a href="/admin/posts/${x.slug}/edit">Edit</a> ${x.published ? `<a href="/blog/${x.slug}">view</a>` : ''}${action(`/admin/posts/${x.slug}/toggle`, x.published ? 'Make draft' : 'Publish')}${action(`/admin/posts/${x.slug}/duplicate`, 'Duplicate')}<button type="button" data-delete="/admin/posts/${x.slug}/delete">Delete</button></td></tr>`,
          )
          .join('') || '<tr><td colspan="4">No posts yet</td></tr>'
      }</tbody></table><nav aria-label="Pagination">${Array.from({ length: pages }, (_, i) => `<a ${i + 1 === current ? 'aria-current="page"' : ''} href="${esc(url({ page: String(i + 1) }))}">Page ${i + 1}</a>`).join('')}</nav><dialog aria-labelledby="delete-title"><h2 id="delete-title">Delete post?</h2><p>This removes the post from your publication.</p><form method="post" id="delete-form"><button>Delete post</button><button type="button" id="cancel-delete">Cancel</button></form></dialog><script>const modal=document.querySelector('dialog');document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>{document.getElementById('delete-form').action=b.dataset.delete;modal.showModal()});document.getElementById('cancel-delete').onclick=()=>modal.close();</script>`,
    );
  }
  if (p === '/admin/comments')
    return send(
      'Comments',
      `<h1>Comment moderation</h1>${comments.map((x) => `<article><h2>${esc(x.author)}</h2><p>${esc(x.comment)}</p><p>Status: ${x.status} · Post: ${esc(x.slug)}</p><form method="post"><input type="hidden" name="id" value="${x.id}"><button name="status" value="approved">Approve</button><button name="status" value="rejected">Reject</button></form></article>`).join('') || '<p>No comments awaiting moderation.</p>'}`,
    );
  if (p === '/admin/settings' || p === '/settings')
    return send(
      'Settings',
      `<h1>Profile and settings</h1><form method="post"><label>Display name<input name="name" value="${esc(profile.name)}" required></label><label>Theme<select name="theme"><option value="light" ${profile.theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${profile.theme === 'dark' ? 'selected' : ''}>Dark</option></select></label><button>Save settings</button></form>`,
    );
  if (p === '/validation')
    return send(
      'Contact',
      `<h1>Contact the editorial team</h1><form id="contact" novalidate><label>Your name<input id="name" required aria-describedby="name-error"></label><span class="error" id="name-error"></span><label>Email address<input id="email" type="email" required aria-describedby="email-error"></label><span class="error" id="email-error"></span><label>Message<textarea id="message" minlength="10" required aria-describedby="message-error"></textarea></label><span class="error" id="message-error"></span><button>Send message</button><p role="status" id="result"></p></form><script>document.getElementById('contact').onsubmit=async e=>{e.preventDefault();let valid=true;for(const id of ['name','email','message']){const el=document.getElementById(id);const ok=el.checkValidity();el.setAttribute('aria-invalid',String(!ok));document.getElementById(id+'-error').textContent=ok?'':id==='message'?'Please enter at least 10 characters.':id==='email'?'Enter a valid email address.':'Enter your name.';if(!ok)valid=false;}document.getElementById('result').textContent=valid?'Message sent. Thank you!':'Please correct the errors below.';if(valid)await fetch('/__log',{method:'POST',body:JSON.stringify({kind:'contact_sent'})});else document.querySelector('[aria-invalid=true]').focus();};</script>`,
    );
  const published = posts.filter((x) => x.published);
  if (p === '/blog') {
    const term = u.searchParams.get('q') || '';
    return send(
      'Blog',
      `<h1>Blog</h1><p>Stories, notes and ideas from our community.</p>${search('Search the blog', term)}<div class="grid">${
        published
          .filter((x) => `${x.title} ${x.body}`.toLowerCase().includes(term.toLowerCase()))
          .map(
            (x) =>
              `<article><span class="badge">${esc(x.tags?.join(' · '))}</span><h2><a href="/blog/${x.slug}">${esc(x.title)}</a></h2><time datetime="${esc(x.created_at)}">${esc(x.created_at?.slice(0, 10))}</time><p>${esc(x.body.slice(0, 140))}</p></article>`,
          )
          .join('') || '<p>No posts yet</p>'
      }</div>`,
      u.searchParams.get('notice') || (req.headers.referer?.includes('/admin/posts/new') ? 'Post saved' : ''),
    );
  }
  const publicPost = /^\/blog\/([a-z0-9-]+)$/.exec(p);
  if (publicPost) {
    const x = posts.find((item) => item.slug === publicPost[1]);
    if (!x) return false;
    const index = published.indexOf(x);
    return send(
      x.title,
      `<article><h1>${esc(x.title)}</h1><p class="muted">${esc(x.created_at?.slice(0, 10))} · ${esc(x.tags?.join(', '))}</p>${x.img ? `<img src="/blog/img/${x.slug}" alt="${esc(x.title)}">` : ''}<p class="prose">${esc(x.body)}</p></article><nav aria-label="Post navigation">${index > 0 ? `<a href="/blog/${published[index - 1].slug}">Previous post</a>` : ''}<a href="/blog">All posts</a>${index >= 0 && index < published.length - 1 ? `<a href="/blog/${published[index + 1].slug}">Next post</a>` : ''}</nav><section aria-label="Comments"><h2>Comments</h2>${
        comments
          .filter((c) => c.slug === x.slug && c.status === 'approved')
          .map((c) => `<article><strong>${esc(c.author)}</strong><p>${esc(c.comment)}</p></article>`)
          .join('') || '<p>Be the first to join the conversation.</p>'
      }<form method="post" action="/comments"><input type="hidden" name="slug" value="${x.slug}"><label>Name<input name="author" required></label><label>Comment<textarea name="comment" required></textarea></label><button>Add comment</button></form></section>`,
    );
  }
  return false;
}
