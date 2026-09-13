import { Hono } from 'hono';

const app = new Hono();

app.get('/favicon.ico', (c) => c.body(null, 204));

// Middleware de Autenticación Zero Trust
app.use('*', async (c, next) => {
  if (c.req.path === '/favicon.ico' || !c.req.path.startsWith('/api/')) {
    return await next();
  }

  let userEmail = c.req.header('cf-access-authenticated-user-email');

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

// Crear nuevo paciente
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
        console.error('Error al limpiar archivo en R2:', cleanupErr);
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
      return c.json({ error: 'Faltan datos obligatorios' }, 400);
    }

    const id = crypto.randomUUID();
    const profesionalId = usuarioActual ? usuarioActual.id : 'usr_1';
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
        console.error('Error al limpiar foto en R2:', cleanupErr);
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

export default app;