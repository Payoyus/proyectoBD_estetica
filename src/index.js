import { Hono } from 'hono';

const app = new Hono();

// Evitar 404 en navegadores por el favicon
app.get('/favicon.ico', (c) => c.body(null, 204));

// ==========================================
// MIDDLEWARE DE AUTENTICACIÓN ZERO TRUST
// ==========================================
app.use('*', async (c, next) => {
  if (c.req.path === '/favicon.ico') {
    return await next();
  }

  let userEmail = c.req.header('cf-access-authenticated-user-email');

  // En entorno local de desarrollo (wrangler dev), simulamos el admin
  if (!userEmail && c.req.header('host')?.includes('localhost')) {
    userEmail = 'payoyus@gmail.com';
  }

  if (!userEmail) {
    return c.text('Acceso no autorizado: No se detectó identidad válida de Zero Trust.', 401);
  }

  const usuario = await c.env.DB.prepare(
    'SELECT * FROM usuarios WHERE email = ? AND activo = 1'
  ).bind(userEmail.toLowerCase().trim()).first();

  if (!usuario) {
    return c.text(`Acceso denegado: El correo ${userEmail} no está registrado en el personal de la clínica.`, 403);
  }

  c.set('usuarioActual', usuario);
  await next();
});

// ==========================================
// 1. ENDPOINTS DE LA API
// ==========================================

// Endpoint para conocer quién está conectado actualmente
app.get('/api/me', (c) => {
  const usuario = c.get('usuarioActual');
  return c.json(usuario);
});

// Listar pacientes con filtro de búsqueda
app.get('/api/pacientes', async (c) => {
  try {
    const q = c.req.query('q');
    let query = 'SELECT * FROM pacientes ORDER BY created_at DESC LIMIT 50';
    let params = [];

    if (q && q.trim() !== '') {
      query = 'SELECT * FROM pacientes WHERE nombre_completo LIKE ? OR dni LIKE ? ORDER BY created_at DESC LIMIT 50';
      params = ['%' + q.trim() + '%', '%' + q.trim() + '%'];
    }

    const res = await c.env.DB.prepare(query).bind(...params).all();
    return c.json(res.results);
  } catch (err) {
    return c.json({ error: 'Error al listar pacientes', detalle: err.message }, 500);
  }
});

// Crear nuevo paciente (JSON liviano)
app.post('/api/pacientes', async (c) => {
  try {
    const body = await c.req.json();
    const { nombre_completo, dni, telefono, email, fecha_nacimiento, antecedentes_alergias } = body;

    if (!nombre_completo || !dni) {
      return c.json({ error: 'Nombre completo y DNI son obligatorios' }, 400);
    }

    const pacienteId = crypto.randomUUID();

    await c.env.DB.prepare(
      `INSERT INTO pacientes (id, nombre_completo, dni, telefono, email, fecha_nacimiento, antecedentes_alergias)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      pacienteId,
      nombre_completo.trim(),
      dni.trim(),
      telefono ? telefono.trim() : null,
      email ? email.trim() : null,
      fecha_nacimiento || null,
      antecedentes_alergias ? antecedentes_alergias.trim() : null
    ).run();

    return c.json({ id: pacienteId, mensaje: 'Paciente registrado exitosamente' }, 201);
  } catch (err) {
    return c.json({ error: 'Error al registrar paciente en D1', detalle: err.message }, 500);
  }
});

// Subir documento de paciente (Stream a R2 con Rollback atómico)
app.post('/api/pacientes/:id/documentos/:tipo', async (c) => {
  let storagePath = null;
  try {
    const pacienteId = c.req.param('id');
    const tipo = c.req.param('tipo');

    if (tipo !== 'consentimiento' && tipo !== 'historia') {
      return c.json({ error: 'Tipo de documento no válido' }, 400);
    }

    const pacienteExiste = await c.env.DB.prepare('SELECT id FROM pacientes WHERE id = ?').bind(pacienteId).first();
    if (!pacienteExiste) {
      return c.json({ error: 'El paciente especificado no existe' }, 404);
    }

    const formData = await c.req.raw.formData();
    const archivo = formData.get('archivo');

    if (!archivo || typeof archivo !== 'object' || archivo.size === 0) {
      return c.json({ error: 'Archivo inválido o vacío' }, 400);
    }

    const ext = archivo.name && archivo.name.includes('.') ? archivo.name.split('.').pop() : 'pdf';
    storagePath = 'documentos/' + pacienteId + '/' + tipo + '_' + crypto.randomUUID() + '.' + ext;

    await c.env.estetica_fotos.put(storagePath, archivo.stream(), {
      httpMetadata: { contentType: archivo.type || 'application/pdf' }
    });

    const columna = tipo === 'consentimiento' ? 'consentimiento_path' : 'historia_clinica_path';
    await c.env.DB.prepare(
      'UPDATE pacientes SET ' + columna + ' = ? WHERE id = ?'
    ).bind(storagePath, pacienteId).run();

    return c.json({ ok: true, storagePath });
  } catch (err) {
    if (storagePath) {
      try {
        await c.env.estetica_fotos.delete(storagePath);
      } catch (cleanupErr) {
        console.error('Error al limpiar archivo huérfano en R2:', cleanupErr);
      }
    }
    return c.json({ error: 'Error al subir documento', detalle: err.message }, 500);
  }
});

// Detalle e historial de un paciente (Consulta unificada sin N+1)
app.get('/api/pacientes/:id/historial', async (c) => {
  try {
    const id = c.req.param('id');

    const paciente = await c.env.DB.prepare('SELECT * FROM pacientes WHERE id = ?').bind(id).first();
    if (!paciente) {
      return c.json({ error: 'Paciente no encontrado' }, 404);
    }

    const { results } = await c.env.DB.prepare(`
      SELECT 
        s.id,
        s.paciente_id,
        s.profesional_id,
        s.profesional_nombre,
        s.tipo_tratamiento,
        s.descripcion,
        s.fecha_tratamiento,
        s.created_at,
        COALESCE(
          json_group_array(
            CASE 
              WHEN f.id IS NOT NULL THEN json_object(
                'id', f.id,
                'sesion_id', f.sesion_id,
                'storage_path', f.storage_path,
                'etiqueta', f.etiqueta,
                'created_at', f.created_at,
                'url_visualizacion', '/api/archivos/' || f.storage_path
              )
              ELSE NULL 
            END
          ) FILTER (WHERE f.id IS NOT NULL),
          '[]'
        ) AS fotos_json
      FROM sesiones_tratamiento s
      LEFT JOIN fotos_tratamiento f ON s.id = f.sesion_id
      WHERE s.paciente_id = ?
      GROUP BY s.id
      ORDER BY s.fecha_tratamiento DESC
    `).bind(id).all();

    const historial = results.map((row) => ({
      id: row.id,
      paciente_id: row.paciente_id,
      profesional_id: row.profesional_id,
      profesional_nombre: row.profesional_nombre,
      tipo_tratamiento: row.tipo_tratamiento,
      descripcion: row.descripcion,
      fecha_tratamiento: row.fecha_tratamiento,
      created_at: row.created_at,
      fotos: JSON.parse(row.fotos_json)
    }));

    return c.json({
      paciente: {
        ...paciente,
        url_consentimiento: paciente.consentimiento_path ? '/api/archivos/' + paciente.consentimiento_path : null,
        url_historia_clinica: paciente.historia_clinica_path ? '/api/archivos/' + paciente.historia_clinica_path : null
      },
      historial
    });
  } catch (err) {
    return c.json({ error: 'Error al obtener historial', detalle: err.message }, 500);
  }
});

// Crear sesión de tratamiento
app.post('/api/sesiones', async (c) => {
  try {
    const body = await c.req.json();
    const usuarioActual = c.get('usuarioActual');
    const { paciente_id, tipo_tratamiento, descripcion, profesional } = body;

    if (!paciente_id || !tipo_tratamiento || !descripcion) {
      return c.json({ error: 'Faltan datos obligatorios (paciente_id, tipo_tratamiento o descripcion)' }, 400);
    }

    const id = crypto.randomUUID();
    // Clave foránea real ligada a usuarios(id)
    const profesionalId = usuarioActual ? usuarioActual.id : 'usr_1';
    // Nombre legible ingresado en el formulario o el usuario activo por defecto
    const nombreProfesional = profesional && profesional.trim() !== '' 
      ? profesional.trim() 
      : (usuarioActual ? usuarioActual.nombre : 'Profesional');

    await c.env.DB.prepare(
      `INSERT INTO sesiones_tratamiento (id, paciente_id, profesional_id, profesional_nombre, tipo_tratamiento, descripcion)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, paciente_id, profesionalId, nombreProfesional, tipo_tratamiento, descripcion).run();

    return c.json({ id, mensaje: 'Sesión registrada con éxito' }, 201);
  } catch (err) {
    return c.json({ error: 'Error en base de datos D1', detalle: err.message }, 500);
  }
});

// Subir fotografías a una sesión (Stream a R2 con Rollback atómico)
app.post('/api/sesiones/:sesion_id/fotos', async (c) => {
  let storage_path = null;
  try {
    const sesion_id = c.req.param('sesion_id');

    const sesionExiste = await c.env.DB.prepare('SELECT id FROM sesiones_tratamiento WHERE id = ?').bind(sesion_id).first();
    if (!sesionExiste) {
      return c.json({ error: 'Error de integridad', detalle: 'La sesión no existe' }, 404);
    }

    const formData = await c.req.raw.formData();
    const foto = formData.get('foto');
    const etiqueta = (formData.get('etiqueta') || 'otro').toString().toLowerCase();

    if (!foto || typeof foto !== 'object' || !('size' in foto) || foto.size === 0) {
      return c.json({ error: 'Validación', detalle: 'El archivo de foto no es válido o llegó vacío' }, 400);
    }

    const fotoId = crypto.randomUUID();
    const nombreOriginal = foto.name || 'foto.jpg';
    const ext = nombreOriginal.includes('.') ? nombreOriginal.split('.').pop() : 'jpg';
    storage_path = 'sesiones/' + sesion_id + '/' + fotoId + '.' + ext;

    await c.env.estetica_fotos.put(storage_path, foto.stream(), {
      httpMetadata: { contentType: foto.type || 'image/jpeg' }
    });

    await c.env.DB.prepare(
      `INSERT INTO fotos_tratamiento (id, sesion_id, storage_path, etiqueta)
       VALUES (?, ?, ?, ?)`
    ).bind(fotoId, sesion_id, storage_path, etiqueta).run();

    return c.json({
      id: fotoId,
      storage_path,
      url: '/api/archivos/' + storage_path,
      mensaje: 'Foto almacenada exitosamente'
    }, 201);
  } catch (err) {
    if (storage_path) {
      try {
        await c.env.estetica_fotos.delete(storage_path);
      } catch (cleanupErr) {
        console.error('Error al limpiar foto huérfana en R2:', cleanupErr);
      }
    }
    return c.json({ error: 'Error al subir la fotografía', detalle: err.message || String(err) }, 500);
  }
});

// Servidor de archivos desde R2
app.get('/api/archivos/*', async (c) => {
  try {
    const path = c.req.path.replace('/api/archivos/', '');
    const object = await c.env.estetica_fotos.get(path);

    if (!object) {
      return c.text('Archivo no encontrado', 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=86400');

    return new Response(object.body, { headers });
  } catch (err) {
    return c.text('Error al obtener archivo: ' + err.message, 500);
  }
});

// ==========================================
// 2. FRONTEND (INTERFAZ DE USUARIO)
// ==========================================
app.get('/', (c) => {
  const usuario = c.get('usuarioActual');
  const usuarioNombre = usuario ? usuario.nombre : '';
  const usuarioLabel = usuario ? `${usuario.nombre} (${usuario.rol.toUpperCase()})` : 'Usuario';

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Clínica Estética - Panel Profesional</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background-color: #f4f6f9; font-family: system-ui, -apple-system, sans-serif; -webkit-tap-highlight-color: transparent; }
    .sidebar { max-height: calc(100vh - 70px); overflow-y: auto; }
    @media (max-width: 768px) {
      .sidebar { max-height: 250px; margin-bottom: 1rem; }
    }
    .paciente-item { cursor: pointer; transition: background 0.15s ease-in-out; }
    .paciente-item:hover { background-color: #e9ecef; }
    .paciente-item.active { background-color: #0d6efd; color: white; }
    .paciente-item.active .text-muted { color: #dee2e6 !important; }
    .photo-card { position: relative; border-radius: 8px; overflow: hidden; background: #000; }
    .photo-tag { position: absolute; top: 8px; left: 8px; font-size: 0.75rem; font-weight: bold; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; z-index: 10; }
    .badge-antes { background: #dc3545; color: white; }
    .badge-despues { background: #198754; color: white; }
    .badge-control { background: #0dcaf0; color: #000; }
    .badge-otro { background: #6c757d; color: white; }
    .doc-badge { text-decoration: none; display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 6px; font-size: 0.9rem; font-weight: 500; }
    .user-pill { font-size: 0.85rem; background: #eef2f7; color: #334155; padding: 5px 12px; border-radius: 20px; font-weight: 500; }
  </style>
</head>
<body>

  <nav class="navbar navbar-expand-lg navbar-dark bg-white border-bottom shadow-sm px-3 px-md-4 py-2 sticky-top">
    <span class="navbar-brand text-dark fw-bold d-flex align-items-center gap-2 mb-0">
      🩺 Clínica Estética
    </span>
    <div class="ms-auto d-flex align-items-center gap-2">
      <span class="user-pill d-none d-sm-inline-block">👤 ${usuarioLabel}</span>
      <button class="btn btn-primary btn-sm" data-bs-toggle="modal" data-bs-target="#modalNuevoPaciente">
        + Nuevo Paciente
      </button>
    </div>
  </nav>

  <div class="container-fluid px-3 px-md-4 mt-3">
    <div class="row">
      
      <!-- Columna Izquierda: Lista de Pacientes -->
      <div class="col-md-4 col-lg-3 sidebar">
        <div class="input-group mb-2">
          <input type="search" id="buscador" class="form-control form-control-sm" placeholder="🔍 Buscar por nombre o DNI..." oninput="filtrarPacientes()">
        </div>
        <div class="list-group shadow-sm bg-white rounded" id="listaPacientes">
          <div class="p-3 text-center text-muted small">Cargando pacientes...</div>
        </div>
      </div>

      <!-- Columna Derecha: Detalle y Evolución -->
      <div class="col-md-8 col-lg-9">
        <div id="placeholderVacio" class="card shadow-sm border-0 p-5 text-center text-muted">
          <h5>Selecciona un paciente de la lista para ver su ficha y registro fotográfico.</h5>
        </div>

        <div id="detallePaciente" class="card shadow-sm border-0 p-3 p-md-4" style="display: none;">
          <div class="d-flex flex-wrap justify-content-between align-items-start border-bottom pb-3 mb-3 gap-2">
            <div>
              <h3 class="mb-1 text-primary fw-bold" id="pacienteNombre"></h3>
              <p class="text-muted mb-0 small" id="pacienteInfo"></p>
            </div>
            <button class="btn btn-outline-primary btn-sm" data-bs-toggle="modal" data-bs-target="#modalNuevaSesion">
              + Nueva Sesión / Foto
            </button>
          </div>

          <div id="alertasAlergia" class="alert alert-warning py-2 px-3 small mb-3" style="display: none;"></div>

          <div class="mb-4 p-3 bg-light rounded border">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <h6 class="fw-bold mb-0 text-secondary">📁 Documentación Adjunta</h6>
              <button class="btn btn-outline-secondary btn-sm py-0 px-2" style="font-size: 0.8rem;" data-bs-toggle="modal" data-bs-target="#modalDocumentacion">
                + Adjuntar / Actualizar
              </button>
            </div>
            <div id="docsContainer" class="d-flex flex-wrap gap-2">
              <span class="text-muted small">Sin documentación adjunta.</span>
            </div>
          </div>

          <h5 class="fw-bold mb-3">Historial Clínico y Fotos</h5>
          <div id="historialSesiones"></div>
        </div>
      </div>

    </div>
  </div>

  <!-- Modal: Nuevo Paciente -->
  <div class="modal fade" id="modalNuevoPaciente" tabindex="-1">
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title fw-bold">Registrar Nuevo Paciente</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <form id="formPaciente" onsubmit="guardarPaciente(event)">
          <div class="modal-body">
            <div class="row g-2">
              <div class="col-md-6 mb-2">
                <label class="form-label small fw-bold">Nombre Completo *</label>
                <input type="text" id="pNombre" class="form-control" required>
              </div>
              <div class="col-md-6 mb-2">
                <label class="form-label small fw-bold">DNI / Identificación *</label>
                <input type="text" id="pDni" class="form-control" required>
              </div>
              <div class="col-md-4 mb-2">
                <label class="form-label small fw-bold">Teléfono</label>
                <input type="tel" id="pTel" class="form-control">
              </div>
              <div class="col-md-4 mb-2">
                <label class="form-label small fw-bold">Email</label>
                <input type="email" id="pEmail" class="form-control">
              </div>
              <div class="col-md-4 mb-2">
                <label class="form-label small fw-bold">Fecha de Nacimiento</label>
                <input type="date" id="pNac" class="form-control">
              </div>
              <div class="col-12 mb-3">
                <label class="form-label small fw-bold">Antecedentes Médicos / Alergias</label>
                <textarea id="pAlergias" class="form-control" rows="2" placeholder="Hipertensión, alergia a la penicilina, etc."></textarea>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Cancelar</button>
            <button type="submit" id="btnGuardarPaciente" class="btn btn-primary btn-sm">Guardar Paciente</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <!-- Modal: Adjuntar Documentación -->
  <div class="modal fade" id="modalDocumentacion" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title fw-bold">Adjuntar Documentación</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <form id="formDocumentacion" onsubmit="guardarDocumentacion(event)">
          <div class="modal-body">
            <div class="mb-3">
              <label class="form-label small fw-bold">Consentimiento Médico (PDF o Imagen)</label>
              <input type="file" id="docConsentimiento" class="form-control" accept=".pdf,image/jpeg,image/png">
            </div>
            <div class="mb-3">
              <label class="form-label small fw-bold">Historia Clínica / Estudios Externos (PDF o Imagen)</label>
              <input type="file" id="docHistoria" class="form-control" accept=".pdf,image/jpeg,image/png">
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Cancelar</button>
            <button type="submit" id="btnGuardarDocs" class="btn btn-primary btn-sm">Subir Documentos</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <!-- Modal: Nueva Sesión -->
  <div class="modal fade" id="modalNuevaSesion" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title fw-bold">Nueva Sesión Clínica</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <form id="formSesion" onsubmit="guardarSesion(event)">
          <div class="modal-body">
            <div class="mb-2">
              <label class="form-label small fw-bold">Profesional a cargo</label>
              <input type="text" id="sProfesional" class="form-control" value="${usuarioNombre}" placeholder="Nombre del profesional que realizó el tratamiento">
              <div class="form-text small">Por defecto tu nombre, modifícalo si estás cargando la ficha de otro profesional.</div>
            </div>
            <div class="mb-2">
              <label class="form-label small fw-bold">Tipo de Tratamiento *</label>
              <input type="text" id="sTipo" class="form-control" placeholder="Ej: Toxina Botulínica, Peeling, Ácido Hialurónico" required>
            </div>
            <div class="mb-2">
              <label class="form-label small fw-bold">Detalles / Evolución Clínica *</label>
              <textarea id="sDesc" class="form-control" rows="3" placeholder="Zonas tratadas, producto aplicado, unidades/ml, etc." required></textarea>
            </div>
            <div class="mb-2">
              <label class="form-label small fw-bold">Adjuntar Fotografía(s)</label>
              <input type="file" id="sFoto" class="form-control" accept="image/jpeg,image/png,image/webp,image/*" multiple>
              <div class="form-text small">Puedes seleccionar varias fotos al mismo tiempo.</div>
            </div>
            <div class="mb-2">
              <label class="form-label small fw-bold">Etiqueta de la Foto</label>
              <select id="sEtiqueta" class="form-select">
                <option value="antes">Antes del procedimiento</option>
                <option value="despues">Inmediatamente Después</option>
                <option value="control">Control</option>
                <option value="otro">Otro</option>
              </select>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Cancelar</button>
            <button type="submit" id="btnGuardarSesion" class="btn btn-primary btn-sm">Guardar Sesión</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    let pacienteActivoId = null;
    const modalPaciente = new bootstrap.Modal(document.getElementById('modalNuevoPaciente'));
    const modalSesion = new bootstrap.Modal(document.getElementById('modalNuevaSesion'));
    const modalDocumentos = new bootstrap.Modal(document.getElementById('modalDocumentacion'));

    window.onload = function() { cargarPacientes(); };

    let timeoutBuscador = null;
    function filtrarPacientes() {
      clearTimeout(timeoutBuscador);
      timeoutBuscador = setTimeout(function() {
        cargarPacientes(document.getElementById('buscador').value);
      }, 250);
    }

    async function cargarPacientes(query) {
      if (!query) query = '';
      const res = await fetch('/api/pacientes?q=' + encodeURIComponent(query), { cache: 'no-store' });
      const pacientes = await res.json();
      const lista = document.getElementById('listaPacientes');
      lista.innerHTML = '';

      if (!pacientes.length) {
        lista.innerHTML = '<div class="p-3 text-center text-muted small">No se encontraron pacientes.</div>';
        return;
      }

      pacientes.forEach(function(p) {
        const item = document.createElement('a');
        item.className = 'list-group-item list-group-item-action paciente-item py-2 px-3 border-start-0 border-end-0 ' + (p.id === pacienteActivoId ? 'active' : '');
        item.innerHTML = '<div class="fw-bold">' + p.nombre_completo + '</div><div class="small text-muted">DNI: ' + p.dni + ' | ' + (p.telefono || 'Sin tel') + '</div>';
        item.onclick = function() { seleccionarPaciente(p.id); };
        lista.appendChild(item);
      });
    }

    async function seleccionarPaciente(id) {
      pacienteActivoId = id;
      document.getElementById('placeholderVacio').style.display = 'none';
      document.getElementById('detallePaciente').style.display = 'block';

      document.querySelectorAll('.paciente-item').forEach(function(el) { el.classList.remove('active'); });

      const res = await fetch('/api/pacientes/' + id + '/historial?t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      const p = data.paciente;

      document.getElementById('pacienteNombre').innerText = p.nombre_completo;
      document.getElementById('pacienteInfo').innerText = 'DNI: ' + p.dni + ' | Tel: ' + (p.telefono || 'N/A') + ' | Email: ' + (p.email || 'N/A');

      const divAlergias = document.getElementById('alertasAlergia');
      if (p.antecedentes_alergias) {
        divAlergias.innerText = '⚠️ Alergias / Antecedentes: ' + p.antecedentes_alergias;
        divAlergias.style.display = 'block';
      } else {
        divAlergias.style.display = 'none';
      }

      const docsDiv = document.getElementById('docsContainer');
      let docsHtml = '';
      if (p.url_consentimiento) {
        docsHtml += '<a href="' + p.url_consentimiento + '" target="_blank" class="btn btn-outline-success btn-sm doc-badge">📄 Consentimiento Médico</a>';
      }
      if (p.url_historia_clinica) {
        docsHtml += '<a href="' + p.url_historia_clinica + '" target="_blank" class="btn btn-outline-info btn-sm doc-badge">📑 Historia Clínica</a>';
      }
      if (!p.url_consentimiento && !p.url_historia_clinica) {
        docsHtml = '<span class="text-muted small">Sin documentación adjunta.</span>';
      }
      docsDiv.innerHTML = docsHtml;

      const contSesiones = document.getElementById('historialSesiones');
      if (!data.historial || !data.historial.length) {
        contSesiones.innerHTML = '<p class="text-muted small">No hay sesiones registradas para este paciente.</p>';
        return;
      }

      let htmlSesiones = '';
      data.historial.forEach(function(s) {
        const fecha = new Date(s.fecha_tratamiento);
        const fechaStr = fecha.toLocaleDateString() + ' ' + fecha.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        let profesionalBadge = '';
        const textoProfesional = s.profesional_nombre || s.profesional_id;
        if (textoProfesional && textoProfesional !== 'profesional_general') {
          profesionalBadge = '<span class="badge bg-light text-dark border">🩺 ' + textoProfesional + '</span>';
        }

        let fotosHtml = '';
        if (s.fotos && s.fotos.length > 0) {
          s.fotos.forEach(function(f) {
            fotosHtml += '<div class="col-6 col-md-4 col-lg-3">' +
              '<div class="photo-card shadow-sm border mb-2">' +
                '<span class="photo-tag badge-' + f.etiqueta + '">' + f.etiqueta.toUpperCase() + '</span>' +
                '<a href="' + f.url_visualizacion + '" target="_blank">' +
                  '<img src="' + f.url_visualizacion + '" alt="Foto" loading="lazy" style="width:100%; height:180px; object-fit:cover; display:block;">' +
                '</a>' +
              '</div>' +
            '</div>';
          });
        } else {
          fotosHtml = '<p class="text-muted small ps-2">Sin fotografías en esta sesión.</p>';
        }

        htmlSesiones += '<div class="border rounded p-3 bg-white mb-3 shadow-sm">' +
          '<div class="d-flex flex-wrap justify-content-between align-items-center mb-1 gap-1">' +
            '<div class="d-flex align-items-center gap-2">' +
              '<span class="badge bg-secondary">' + s.tipo_tratamiento + '</span>' +
              profesionalBadge +
            '</div>' +
            '<small class="text-muted">' + fechaStr + '</small>' +
          '</div>' +
          '<p class="small text-secondary mb-2">' + (s.descripcion || '') + '</p>' +
          '<div class="row g-2 mt-1">' + fotosHtml + '</div>' +
        '</div>';
      });

      contSesiones.innerHTML = htmlSesiones;
    }

    async function guardarPaciente(e) {
      e.preventDefault();
      const btn = document.getElementById('btnGuardarPaciente');
      btn.disabled = true;
      btn.innerText = 'Guardando...';

      const payload = {
        nombre_completo: document.getElementById('pNombre').value,
        dni: document.getElementById('pDni').value,
        telefono: document.getElementById('pTel').value,
        email: document.getElementById('pEmail').value,
        fecha_nacimiento: document.getElementById('pNac').value,
        antecedentes_alergias: document.getElementById('pAlergias').value
      };

      try {
        const res = await fetch('/api/pacientes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || data.detalle || 'Error al guardar');

        modalPaciente.hide();
        document.getElementById('formPaciente').reset();
        await cargarPacientes();
        await seleccionarPaciente(data.id);
      } catch (err) {
        alert('Error: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Guardar Paciente';
      }
    }

    async function guardarDocumentacion(e) {
      e.preventDefault();
      if (!pacienteActivoId) {
        alert('Selecciona primero un paciente.');
        return;
      }

      const fileConsentimiento = document.getElementById('docConsentimiento').files[0];
      const fileHistoria = document.getElementById('docHistoria').files[0];

      if (!fileConsentimiento && !fileHistoria) {
        alert('Por favor selecciona al menos un archivo.');
        return;
      }

      const btn = document.getElementById('btnGuardarDocs');
      btn.disabled = true;
      btn.innerText = 'Subiendo en paralelo...';

      try {
        const promesas = [];

        if (fileConsentimiento) {
          const fd = new FormData();
          fd.append('archivo', fileConsentimiento);
          promesas.push(
            fetch('/api/pacientes/' + pacienteActivoId + '/documentos/consentimiento', { method: 'POST', body: fd })
              .then(async function(r) { if (!r.ok) throw new Error('Error al subir Consentimiento'); })
          );
        }

        if (fileHistoria) {
          const fd = new FormData();
          fd.append('archivo', fileHistoria);
          promesas.push(
            fetch('/api/pacientes/' + pacienteActivoId + '/documentos/historia', { method: 'POST', body: fd })
              .then(async function(r) { if (!r.ok) throw new Error('Error al subir Historia Clínica'); })
          );
        }

        await Promise.all(promesas);

        modalDocumentos.hide();
        document.getElementById('formDocumentacion').reset();
        await seleccionarPaciente(pacienteActivoId);
      } catch (err) {
        alert('Error: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Subir Documentos';
      }
    }

    async function optimizarImagen(archivo) {
      if (!archivo.type.startsWith('image/')) return archivo;

      return new Promise(function(resolve) {
        const reader = new FileReader();
        reader.readAsDataURL(archivo);
        reader.onload = function(event) {
          const img = new Image();
          img.src = event.target.result;
          img.onload = function() {
            const canvas = document.createElement('canvas');
            const MAX = 1400;
            let width = img.width;
            let height = img.height;

            if (width > height && width > MAX) {
              height *= MAX / width;
              width = MAX;
            } else if (height > MAX) {
              width *= MAX / height;
              height = MAX;
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob(function(blob) {
              if (!blob) return resolve(archivo);
              const archivoComprimido = new File([blob], archivo.name.replace(/\.[^/.]+$/, ".jpg"), {
                type: 'image/jpeg',
                lastModified: Date.now()
              });
              resolve(archivoComprimido);
            }, 'image/jpeg', 0.80);
          };
          img.onerror = function() { resolve(archivo); };
        };
        reader.onerror = function() { resolve(archivo); };
      });
    }

    async function guardarSesion(e) {
      e.preventDefault();
      const btn = document.getElementById('btnGuardarSesion');
      btn.disabled = true;
      btn.innerText = 'Creando sesión...';

      if (!pacienteActivoId) {
        alert('Error: No hay paciente seleccionado.');
        btn.disabled = false;
        btn.innerText = 'Guardar Sesión';
        return;
      }

      const profesional = document.getElementById('sProfesional').value;
      const tipo = document.getElementById('sTipo').value;
      const desc = document.getElementById('sDesc').value;

      try {
        const res = await fetch('/api/sesiones', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paciente_id: pacienteActivoId,
            profesional: profesional,
            tipo_tratamiento: tipo,
            descripcion: desc
          })
        });

        const data = await res.json();
        if (!res.ok || !data.id) {
          throw new Error(data.error || data.detalle || 'Error al crear sesión.');
        }

        const nuevaSesionId = data.id;
        const fotoInput = document.getElementById('sFoto');

        if (fotoInput.files && fotoInput.files.length > 0) {
          const etiqueta = document.getElementById('sEtiqueta').value;
          const total = fotoInput.files.length;

          for (let i = 0; i < total; i++) {
            btn.innerText = 'Optimizando foto ' + (i + 1) + '/' + total + '...';
            const fotoOptimizada = await optimizarImagen(fotoInput.files[i]);

            btn.innerText = 'Subiendo foto ' + (i + 1) + '/' + total + '...';
            const formData = new FormData();
            formData.append('foto', fotoOptimizada);
            formData.append('etiqueta', etiqueta);

            const uploadRes = await fetch('/api/sesiones/' + nuevaSesionId + '/fotos', {
              method: 'POST',
              body: formData
            });

            if (!uploadRes.ok) {
              const errUpload = await uploadRes.json();
              throw new Error(errUpload.error || 'Error al subir foto ' + (i + 1));
            }
          }
        }

        modalSesion.hide();
        document.getElementById('formSesion').reset();
        await seleccionarPaciente(pacienteActivoId);
      } catch (err) {
        alert('Fallo: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Guardar Sesión';
      }
    }
  </script>
</body>
</html>`;
  return c.html(html);
});

export default app;