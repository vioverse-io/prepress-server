const useWindowsAuth = (process.env.SQL_AUTH || '').toLowerCase() === 'windows';
const sql = useWindowsAuth ? require('mssql/msnodesqlv8') : require('mssql');

function buildConfig() {
    if (useWindowsAuth) {
        const driver = process.env.SQL_ODBC_DRIVER || 'ODBC Driver 18 for SQL Server';
        const server = process.env.SQL_SERVER;
        const port = process.env.SQL_PORT || '';
        const database = process.env.SQL_DATABASE;
        const encrypt = process.env.SQL_ENCRYPT === 'true' ? 'Yes' : 'No';
        const trustCert = process.env.SQL_TRUST_SERVER_CERT !== 'false' ? 'Yes' : 'No';
        // Named instances (e.g. localhost\SQLEXPRESS) use dynamic ports via
        // SQL Server Browser -- don't append a port. Only append port when
        // connecting to a default instance by IP/hostname.
        const serverPart = (server.includes('\\') || !port) ? server : `${server},${port}`;
        return {
            connectionString: `Driver={${driver}};Server=${serverPart};Database=${database};Trusted_Connection=Yes;Encrypt=${encrypt};TrustServerCertificate=${trustCert};`,
            pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
        };
    }
    return {
        server: process.env.SQL_SERVER,
        port: parseInt(process.env.SQL_PORT || '1433', 10),
        database: process.env.SQL_DATABASE,
        user: process.env.SQL_USER,
        password: process.env.SQL_PASSWORD,
        options: {
            encrypt: process.env.SQL_ENCRYPT === 'true',
            trustServerCertificate: process.env.SQL_TRUST_SERVER_CERT !== 'false'
        },
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
    };
}
const config = buildConfig();

let pool = null;

async function getPool() {
    if (!pool) {
        pool = await sql.connect(config);
    }
    return pool;
}

async function query(strings, ...values) {
    const p = await getPool();
    const req = p.request();
    // Tagged template literal support: query`SELECT * FROM jobs WHERE id = ${id}`
    let text = '';
    strings.forEach((str, i) => {
        text += str;
        if (i < values.length) {
            const paramName = 'p' + i;
            req.input(paramName, values[i]);
            text += '@' + paramName;
        }
    });
    return req.query(text);
}

async function healthCheck() {
    try {
        const p = await getPool();
        const result = await p.request().query('SELECT 1 AS ok');
        return { connected: true };
    } catch (err) {
        return { connected: false, error: err.message };
    }
}

module.exports = { getPool, query, healthCheck, sql };
