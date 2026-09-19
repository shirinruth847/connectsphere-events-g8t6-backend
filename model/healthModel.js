const supabase = require("../config/supabase");

const healthCheck = async () => {
    try {
        const { error } = await supabase.from("_dummmy_table_test").select("*").limit(1);
        if (error && error.code !== "PGRST205") {
            throw new Error(`[Supabase Error] ${error.message}`);
        }

        return "App is working well";
    } catch (error) {
        throw new Error(`Health check failed: ${error.message}`);
    }
};

module.exports = healthCheck;
